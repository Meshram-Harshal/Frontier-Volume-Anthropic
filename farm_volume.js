/**
 * Jupiter volume loop: buy USDC -> token, then sell the full token balance back to USDC.
 *
 * Cadence
 *   t=0s   buy BUY_USDC of the token
 *   t=10s  sell the entire token balance for USDC
 *   t=20s  buy again
 *   stops when tracked USDC notional reaches TARGET_VOLUME_USD
 *   on stop (target, Ctrl+C, or repeated failures) any leftover token is sold, so the
 *   wallet always ends in USDC
 *
 * Each confirmed buy adds the USDC spent. Each confirmed sell adds the USDC received.
 * Local volume is not Jupiter's leaderboard. The event indexer is the source of truth.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import dotenv from "dotenv";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;
const STATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "volume_state.json");
const MAX_CONSECUTIVE_FAILURES = 5;

let stopping = false;

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function money(value) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function loadSecret(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Uint8Array.from(JSON.parse(trimmed));
  }
  return bs58.decode(trimmed);
}

function loadConfig() {
  dotenv.config();
  const privateKey = (process.env.PRIVATE_KEY || "").trim();
  const rpcUrl = (process.env.RPC_URL || "").trim();
  const tokenMint = (process.env.TOKEN_MINT || "").trim();
  const apiKey = (process.env.API_KEY || "").trim();

  if (!privateKey) die("set PRIVATE_KEY in .env (base58 secret key)");
  if (!rpcUrl) die("set RPC_URL in .env");
  if (!tokenMint) die("set TOKEN_MINT in .env to the coin you want to farm");

  const buyUsdc = Number(process.env.BUY_USDC || "100");
  const interval = Number(process.env.INTERVAL_SEC || "10");
  const target = Number(process.env.TARGET_VOLUME_USD || "60000");
  const slippageBps = Number(process.env.SLIPPAGE_BPS || "100");
  const maxPriority = Number(process.env.MAX_PRIORITY_LAMPORTS || "48800");
  const numbers = [buyUsdc, interval, target, slippageBps, maxPriority];
  if (numbers.some((value) => Number.isNaN(value))) {
    die("BUY_USDC, INTERVAL_SEC, TARGET_VOLUME_USD, SLIPPAGE_BPS, MAX_PRIORITY_LAMPORTS must be numbers");
  }
  if (buyUsdc <= 0 || interval < 0 || target <= 0) {
    die("BUY_USDC and TARGET_VOLUME_USD must be > 0");
  }
  if (slippageBps < 1 || slippageBps > 5000) {
    die("SLIPPAGE_BPS must be between 1 and 5000");
  }

  return {
    privateKey,
    rpcUrl,
    tokenMint,
    apiBase: apiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag",
    headers: apiKey ? { "x-api-key": apiKey } : {},
    buyUsdc,
    buyRaw: BigInt(Math.round(buyUsdc * 10 ** USDC_DECIMALS)),
    interval,
    target,
    slippageBps,
    maxPriority,
  };
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { volume_usd: 0, buys: 0, sells: 0 };
  }
  try {
    const data = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return {
      volume_usd: Number(data.volume_usd || 0),
      buys: Number(data.buys || 0),
      sells: Number(data.sells || 0),
    };
  } catch {
    die("volume_state.json is corrupt. Delete it to start volume from 0.");
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function tokenBalanceRaw(connection, owner, mint) {
  const accounts = await connection.getParsedTokenAccountsByOwner(
    owner,
    { mint: new PublicKey(mint) },
    "confirmed",
  );
  let best = 0n;
  for (const account of accounts.value) {
    const amount = BigInt(account.account.data.parsed.info.tokenAmount.amount);
    if (amount > best) best = amount;
  }
  return best;
}

async function requestWithRetry(url, options) {
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(url, options);
    if (response.status !== 429 || attempt === 3) return response;
    await sleep(1500 * (attempt + 1));
  }
  return response;
}

async function getQuote(cfg, inputMint, outputMint, amountRaw) {
  const url = new URL(`${cfg.apiBase}/swap/v1/quote`);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amountRaw.toString());
  url.searchParams.set("slippageBps", String(cfg.slippageBps));
  url.searchParams.set("restrictIntermediateTokens", "true");

  const response = await requestWithRetry(url, { headers: cfg.headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`quote failed (${response.status}): ${text.slice(0, 400)}`);
  }
  const quote = await response.json();
  if (quote.error || !quote.outAmount) {
    throw new Error(`quote rejected: ${JSON.stringify(quote)}`);
  }
  return quote;
}

async function sendSwap(cfg, connection, wallet, quote) {
  const response = await requestWithRetry(`${cfg.apiBase}/swap/v1/swap`, {
    method: "POST",
    headers: { ...cfg.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      userPublicKey: wallet.publicKey.toBase58(),
      quoteResponse: quote,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: cfg.maxPriority,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`swap build failed (${response.status}): ${text.slice(0, 400)}`);
  }
  const swapData = await response.json();
  if (swapData.simulationError) {
    throw new Error(`simulation error: ${JSON.stringify(swapData.simulationError)}`);
  }

  const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
  transaction.sign([wallet]);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 3,
  });
  return signature;
}

async function waitForConfirmation(connection, signature, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status) {
      if (status.err) {
        throw new Error(`transaction ${signature} failed on-chain: ${JSON.stringify(status.err)}`);
      }
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        return;
      }
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${signature}`);
}

async function sleepUntil(when) {
  while (Date.now() < when) {
    if (stopping) return;
    await sleep(Math.min(200, when - Date.now()));
  }
}

function logTrade(side, detail, added, state, target, signature) {
  const stamp = new Date().toTimeString().slice(0, 8);
  console.log(
    `[${stamp}] ${side.padEnd(4)} ${detail} | +$${money(added)} | ` +
      `volume $${money(state.volume_usd)} / $${target.toLocaleString("en-US")} | ` +
      `https://solscan.io/tx/${signature}`,
  );
}

async function usdcDelta(connection, owner, beforeRaw, direction) {
  const deadline = Date.now() + 15000;
  while (true) {
    const afterRaw = await tokenBalanceRaw(connection, owner, USDC_MINT);
    const moved = direction === "spent" ? beforeRaw - afterRaw : afterRaw - beforeRaw;
    if (moved > 0n || Date.now() >= deadline) {
      return Number(moved > 0n ? moved : 0n) / 10 ** USDC_DECIMALS;
    }
    await sleep(400);
  }
}

async function sellAll(cfg, connection, wallet, state) {
  const balanceRaw = await tokenBalanceRaw(connection, wallet.publicKey, cfg.tokenMint);
  if (balanceRaw <= 0n) throw new Error("token balance is 0, nothing to sell");

  const amounts = [balanceRaw, (balanceRaw * 995n) / 1000n];
  let lastError;
  for (const amountRaw of amounts) {
    if (amountRaw <= 0n) continue;
    try {
      const usdcBefore = await tokenBalanceRaw(connection, wallet.publicKey, USDC_MINT);
      const quote = await getQuote(cfg, cfg.tokenMint, USDC_MINT, amountRaw);
      const signature = await sendSwap(cfg, connection, wallet, quote);
      await waitForConfirmation(connection, signature);
      let received = await usdcDelta(connection, wallet.publicKey, usdcBefore, "received");
      if (received <= 0) received = Number(quote.outAmount) / 10 ** USDC_DECIMALS;
      state.volume_usd += received;
      state.sells += 1;
      saveState(state);
      logTrade("SELL", `token balance -> $${money(received)} USDC`, received, state, cfg.target, signature);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// Make sure the wallet ends in USDC, never in the farmed token.
// Retries a few times so one bad quote does not leave a bag behind.
async function liquidateToUsdc(cfg, connection, wallet, state) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const balanceRaw = await tokenBalanceRaw(connection, wallet.publicKey, cfg.tokenMint);
    if (balanceRaw <= 0n) {
      console.log("wallet holds no token. Final balance is all USDC.");
      return true;
    }
    console.log(`selling leftover token balance back to USDC (attempt ${attempt}/3)...`);
    try {
      await sellAll(cfg, connection, wallet, state);
    } catch (error) {
      const stamp = new Date().toTimeString().slice(0, 8);
      console.log(`[${stamp}] final sell failed: ${error.message}`);
      await sleep(2000);
    }
  }
  const left = await tokenBalanceRaw(connection, wallet.publicKey, cfg.tokenMint);
  if (left > 0n) {
    console.log("WARNING: could not sell the full token balance. Wallet still holds the token. Run the script again to retry.");
    return false;
  }
  console.log("wallet holds no token. Final balance is all USDC.");
  return true;
}

async function main() {
  const cfg = loadConfig();
  const wallet = Keypair.fromSecretKey(loadSecret(cfg.privateKey));
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const state = loadState();

  const usdcRaw = await tokenBalanceRaw(connection, wallet.publicKey, USDC_MINT);
  const sol = (await connection.getBalance(wallet.publicKey, "confirmed")) / 1e9;
  const holding = await tokenBalanceRaw(connection, wallet.publicKey, cfg.tokenMint);
  const usdc = Number(usdcRaw) / 10 ** USDC_DECIMALS;

  console.log(`wallet:  ${wallet.publicKey.toBase58()}`);
  console.log(`token:   ${cfg.tokenMint}`);
  console.log(`usdc:    ${money(usdc)}`);
  console.log(`sol:     ${sol.toFixed(4)}`);
  console.log(`holding: ${holding > 0n ? "yes, the first action will sell the entire balance" : "no"}`);
  console.log(
    `plan:    buy $${cfg.buyUsdc.toFixed(2)} -> wait ${cfg.interval}s -> sell all -> repeat until $${cfg.target.toLocaleString("en-US")}`,
  );
  console.log(
    `volume:  $${money(state.volume_usd)} already counted (${state.buys} buys, ${state.sells} sells)`,
  );
  if (sol < 0.02) {
    die("wallet has under 0.02 SOL. Priority fees will fail. Send SOL first.");
  }

  console.log("starting in 5 seconds. Ctrl+C stops after the current swap.");
  await sleep(5000);

  let nextAction = Date.now();
  let failures = 0;
  let fatal = null;

  try {
    while (!stopping) {
      const holdingRaw = await tokenBalanceRaw(connection, wallet.publicKey, cfg.tokenMint);
      if (state.volume_usd >= cfg.target && holdingRaw <= 0n) break;

      await sleepUntil(nextAction);
      if (stopping) break;
      nextAction = Date.now() + cfg.interval * 1000;

      try {
        if (holdingRaw > 0n) {
          await sellAll(cfg, connection, wallet, state);
        } else if (state.volume_usd >= cfg.target) {
          break;
        } else {
          const usdcBefore = await tokenBalanceRaw(connection, wallet.publicKey, USDC_MINT);
          if (usdcBefore < cfg.buyRaw) {
            const have = Number(usdcBefore) / 10 ** USDC_DECIMALS;
            die(`need $${cfg.buyUsdc.toFixed(2)} USDC to buy, wallet has $${money(have)}`);
          }
          const quote = await getQuote(cfg, USDC_MINT, cfg.tokenMint, cfg.buyRaw);
          const signature = await sendSwap(cfg, connection, wallet, quote);
          await waitForConfirmation(connection, signature);
          let spent = await usdcDelta(connection, wallet.publicKey, usdcBefore, "spent");
          if (spent <= 0) spent = Number(quote.inAmount) / 10 ** USDC_DECIMALS;
          state.volume_usd += spent;
          state.buys += 1;
          saveState(state);
          logTrade("BUY", `$${money(spent)} USDC -> token`, spent, state, cfg.target, signature);
        }
        failures = 0;
      } catch (error) {
        failures += 1;
        const side = holdingRaw > 0n ? "sell" : "buy";
        const stamp = new Date().toTimeString().slice(0, 8);
        console.log(`[${stamp}] ${side} failed (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${error.message}`);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          fatal = "too many failed swaps in a row. Stopping so fees do not keep burning.";
          break;
        }
        nextAction = Date.now() + 2000;
      }
    }
  } catch (error) {
    // Anything unexpected (e.g. an RPC read failing) still ends with a sell-to-USDC attempt.
    fatal = `unexpected error: ${error.message}`;
  }

  if (stopping || fatal) {
    console.log(stopping ? "stopped. Converting any leftover token back to USDC..." : `error: ${fatal}`);
    await liquidateToUsdc(cfg, connection, wallet, state);
    console.log("volume so far is saved in volume_state.json.");
    if (fatal) process.exit(1);
    return;
  }

  console.log(
    `done. Tracked volume $${money(state.volume_usd)} from ${state.buys} buys and ${state.sells} sells.`,
  );
}

process.on("SIGINT", () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.log("\nstopping after the current swap, then selling any leftover token back to USDC...");
});

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
