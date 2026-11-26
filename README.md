# Jupiter Volume Farm

Loops swaps on Solana through the Jupiter API: buy a token with USDC, wait, sell the whole token balance back to USDC, repeat until a target volume is reached.

The wallet always ends in USDC. On target reached, Ctrl+C, or repeated failures, any leftover token is sold back to USDC before the script exits.

> Use at your own risk. This trades real funds on mainnet. Fees, slippage and price impact cost money on every swap. Local volume tracking is not Jupiter's official leaderboard.

## Setup

Requires Node.js 18+.

```bash
npm install
cp .env.example .env   # on Windows: copy .env.example .env
```

Fill in `.env`, then run:

```bash
npm start
```

## Configuration (`.env`)

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | yes | Base58 secret key (or JSON byte array) of the swapping wallet |
| `RPC_URL` | yes | Solana mainnet RPC URL. A private RPC lands faster |
| `TOKEN_MINT` | yes | Mint address of the token to farm. USDC is the other side of every swap |
| `API_KEY` | no | Paid Jupiter key. Blank uses the free lite API |
| `BUY_USDC` | no | USDC spent per buy (default 100) |
| `INTERVAL_SEC` | no | Seconds between each buy and sell (default 10) |
| `TARGET_VOLUME_USD` | no | Stop once tracked volume reaches this (default 60000) |
| `SLIPPAGE_BPS` | no | Slippage in basis points, 100 = 1% (default 100) |
| `MAX_PRIORITY_LAMPORTS` | no | Priority fee per swap in lamports (default 48800) |

The wallet needs USDC for the buys and at least 0.02 SOL for fees.

## Switching to a different token

1. Change `TOKEN_MINT` in `.env`.
2. Delete `volume_state.json` so volume starts from 0.
3. Adjust `TARGET_VOLUME_USD`, `BUY_USDC` and `SLIPPAGE_BPS` for the new token's liquidity.

## Progress file

Progress is saved to `volume_state.json` (git-ignored). Delete it to reset the counter.

## Security

- Never commit `.env`. It holds your private key and is git-ignored.
- Use a dedicated wallet funded with only what you are willing to risk.
