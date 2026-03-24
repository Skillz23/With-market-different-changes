# Orderly Market Maker v9

Automated market making bot on [Orderly Network](https://orderly.network/) (PerpTools) for volume farming and airdrop leaderboard participation.

## Architecture

Ported from [yat1ma30/zo-market-maker-ts](https://github.com/yat1ma30/zo-market-maker-ts) to Orderly REST API.

```
BinanceFeed     → real-time fair price via Binance futures WS
OrderlyFeed     → Orderly orderbook offset correction
FairPriceCalc   → fair_price = binance_mid + median(offset, 5min)
VolatilityMeter → dynamic spread based on 5min realized vol
TrendDetector   → 15min + 1h + 4h momentum filter
PositionTracker → optimistic fill updates + server sync
Quoter          → bid/ask from fair price + effective spread
MarketMaker     → main loop, isUpdating lock, order management
```

## Strategy

Places POST_ONLY maker orders on BTC/USDC perp, captures the spread on fills, and closes positions quickly.

**OPEN mode:** BUY @ fair - spread, SELL @ fair + spread  
**CLOSE mode:** position >= $10 → one side only at fair ± TAKE_PROFIT_BPS

## Volatility-Based Spread

5min realized volatility drives spread width automatically — no time-based profiles needed:

| Level | Vol (bps/min) | Spread |
|-------|--------------|--------|
| 🟢 LOW | < 5 | 5 bps |
| 🟡 MID | 5 - 15 | 8 bps |
| 🔴 HIGH | > 15 | 12 bps |

Handles sudden BTC volatility spikes automatically without manual intervention.

## Trend Filter (15min + 1h + 4h)

All timeframes must agree before filtering sides:

```
📈 UP:   15m > +50 AND 1h > +50 AND 4h > +50 → SELL only
📉 DOWN: 15m < -50 AND 1h < -50 AND 4h < -50 → BUY only
➡️ RANGING: any disagreement                  → both sides
```

**Activation timeline:**
```
0 - 15min  → RANGING always (no data yet)
15min - 2h → Both sides always (accumulating data)
2h+        → Trend filter ON (15min + 1h)
4h+        → Full filter (15min + 1h + 4h)
```

## Status Line

```
[OPEN] fair=$70,650 | pos=0.000 BTC ($0.00) | ➡️ RANGING | 15m: 6.5 bps | 1h: -- | 4h: -- | 🟢 LOW vol (2.3 bps/min) → spread 5 bps | ⏳ filter in 85min | orders=[BUY@70,614, SELL@70,685]
```

## Setup

### Requirements

- Node.js 18+
- npm

### Install

```bash
git clone https://github.com/Skillz23/With-market-different-changes.git
cd With-market-different-changes
npm install typescript ts-node dotenv ws @types/node @types/ws axios bs58 @noble/ed25519@1.7.3 @noble/hashes
```

### Configure

```bash
cp .env.example .env
```

Edit `.env` with your Orderly credentials and settings.

### Run

```bash
# Dry run (safe, no real orders)
DRY_RUN=true npx ts-node bot.ts

# Live trading
DRY_RUN=false npx ts-node bot.ts
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SPREAD_BPS` | 8 | Mid volatility spread |
| `SPREAD_LOW_BPS` | 5 | Low volatility spread |
| `SPREAD_HIGH_BPS` | 12 | High volatility spread |
| `TAKE_PROFIT_BPS` | 3 | Close position spread |
| `ORDER_SIZE_USD` | 350 | Order size in USD |
| `CLOSE_THRESHOLD_USD` | 10 | Position size to trigger close mode |
| `TREND_THRESHOLD_BPS` | 50 | Min move to confirm trend |
| `VOL_LOW_THRESHOLD` | 5 | Vol below this = LOW (bps/min) |
| `VOL_HIGH_THRESHOLD` | 15 | Vol above this = HIGH (bps/min) |

## Disclaimer

This bot is for educational purposes. Use at your own risk. Always start with `DRY_RUN=true` to verify behavior before trading real funds.
