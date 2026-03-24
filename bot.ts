/**
 * Orderly Market Maker v9
 *
 * Direct port of github.com/yat1ma30/zo-market-maker-ts to Orderly Network.
 *
 * Architecture (mirrors friend's bot exactly):
 *
 *   BinanceFeed      → raw Binance futures mid price (bookTicker WS)
 *   OrderlyFeed      → raw Orderly mid price (orderbook polling)
 *   FairPriceCalc    → fair_price = binance_mid + median(orderly-binance offset, 5min)
 *   PositionTracker  → optimistic updates + periodic server sync
 *   Quoter           → bid/ask prices from fair price + spread
 *   MarketMaker      → main loop, order management, fill detection
 *
 * Strategy:
 *   OPEN mode:  BUY  @ fair - SPREAD_BPS
 *               SELL @ fair + SPREAD_BPS
 *
 *   CLOSE mode: position >= CLOSE_THRESHOLD_USD
 *               → one side only (reducing)
 *               → at fair ± TAKE_PROFIT_BPS
 *
 *   |---- 10bps ----|---- 10bps ----|
 *   BUY          Fair Price        SELL
 *  $99,900        $100,000        $100,100
 */

import * as dotenv from "dotenv";
import { OrderlySigner } from "./signer";

dotenv.config();

// ─── Config ────────────────────────────────────────────────────────────────

const ACCOUNT_ID             = process.env.ORDERLY_ACCOUNT_ID!;
const PUBLIC_KEY             = process.env.ORDERLY_PUBLIC_KEY!;
const SECRET                 = process.env.ORDERLY_SECRET!;
const SYMBOL                 = process.env.SYMBOL                   || "PERP_BTC_USDC";
const BINANCE_SYMBOL         = process.env.BINANCE_SYMBOL           || "btcusdt";
const DRY_RUN                = process.env.DRY_RUN                  === "true";
const SPREAD_BPS             = parseFloat(process.env.SPREAD_BPS             || "10");
const TAKE_PROFIT_BPS        = parseFloat(process.env.TAKE_PROFIT_BPS        || "5");
const ORDER_SIZE_USD         = parseFloat(process.env.ORDER_SIZE_USD          || "350");
const CLOSE_THRESHOLD        = parseFloat(process.env.CLOSE_THRESHOLD_USD     || "10");
const WARMUP_SECONDS         = parseInt(  process.env.WARMUP_SECONDS          || "10");
const UPDATE_THROTTLE_MS     = parseInt(  process.env.UPDATE_THROTTLE_MS      || "100");
const ORDER_SYNC_INTERVAL_MS = parseInt(  process.env.ORDER_SYNC_INTERVAL_MS  || "3000");
const STATUS_INTERVAL_MS     = parseInt(  process.env.STATUS_INTERVAL_MS      || "1000");
const FAIR_PRICE_WINDOW_MS   = parseInt(  process.env.FAIR_PRICE_WINDOW_MS    || "300000");
const POSITION_SYNC_MS       = parseInt(  process.env.POSITION_SYNC_INTERVAL_MS || "5000");
const TREND_THRESHOLD_BPS    = parseFloat(process.env.TREND_THRESHOLD_BPS          || "50");
const TREND_15MIN_MS         = 15 * 60 * 1000;
const TREND_1H_MS            = 60 * 60 * 1000;
const TREND_4H_MS            = 4 * 60 * 60 * 1000;
const TREND_ACTIVATION_MS    = 2 * 60 * 60 * 1000; // wait 2h before filtering

// Volatility-based spread — 5min realized vol drives spread width
// Low:  < VOL_LOW_BPS  → SPREAD_LOW_BPS  (tight, more fills)
// Mid:  < VOL_HIGH_BPS → SPREAD_BPS      (normal, from .env)
// High: >= VOL_HIGH_BPS → SPREAD_HIGH_BPS (wide, protection)
const VOL_WINDOW_MS          = 5 * 60 * 1000;   // 5min lookback
const VOL_LOW_THRESHOLD      = parseFloat(process.env.VOL_LOW_THRESHOLD  || "5");  // bps/min
const VOL_HIGH_THRESHOLD     = parseFloat(process.env.VOL_HIGH_THRESHOLD || "15"); // bps/min
const SPREAD_LOW_BPS         = parseFloat(process.env.SPREAD_LOW_BPS     || "7");  // low vol
const SPREAD_HIGH_BPS        = parseFloat(process.env.SPREAD_HIGH_BPS    || "15"); // high vol

// ─── Utilities ─────────────────────────────────────────────────────────────

const log  = (msg: string) => console.log(`[${new Date().toISOString()}]  ${msg}`);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

// ─── BinanceFeed ───────────────────────────────────────────────────────────
// Mirrors friend's binance.ts exactly
// Connects to Binance FUTURES bookTicker WebSocket
// Handles ping/pong, stale detection, reconnect

const BINANCE_FUTURES_WS      = "wss://fstream.binance.com/ws";
const PING_INTERVAL_MS        = 30_000;
const PONG_TIMEOUT_MS         = 10_000;
const STALE_THRESHOLD_MS      = 60_000;
const STALE_CHECK_INTERVAL_MS = 10_000;

interface MidPrice {
  mid: number;
  bid: number;
  ask: number;
  timestamp: number;
}

class BinanceFeed {
  private ws:                  any = null;
  private latestPrice:         MidPrice | null = null;
  private reconnectTimeout:    any = null;
  private pingInterval:        any = null;
  private pongTimeout:         any = null;
  private staleCheckInterval:  any = null;
  private lastMessageTime      = 0;
  private isClosing            = false;
  private readonly wsUrl:      string;

  onPrice: ((p: MidPrice) => void) | null = null;

  constructor() {
    this.wsUrl = `${BINANCE_FUTURES_WS}/${BINANCE_SYMBOL.toLowerCase()}@bookTicker`;
  }

  connect(): void {
    if (this.ws) return;
    log(`Connecting to Binance Futures (${this.wsUrl})...`);
    const { WebSocket } = require("ws");
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on("open", () => {
      log("✅ Binance connected");
      this.lastMessageTime = Date.now();
      this.startPingInterval();
      this.startStaleCheck();
    });

    this.ws.on("message", (data: Buffer) => {
      this.lastMessageTime = Date.now();
      try {
        const msg = JSON.parse(data.toString());
        const bid = parseFloat(msg.b);
        const ask = parseFloat(msg.a);
        if (!bid || !ask) return;
        this.latestPrice = { mid: (bid + ask) / 2, bid, ask, timestamp: Date.now() };
        if (this.onPrice) this.onPrice(this.latestPrice);
      } catch (_) {}
    });

    this.ws.on("ping", (data: Buffer) => { this.ws?.pong(data); });
    this.ws.on("pong", () => { this.clearPongTimeout(); });
    this.ws.on("error", (err: Error) => { log(`⚠️  Binance error: ${err.message}`); });
    this.ws.on("close", () => {
      log("⚠️  Binance disconnected");
      this.cleanup();
      if (!this.isClosing) this.scheduleReconnect();
    });
  }

  private startPingInterval() {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === 1) { // OPEN
        this.ws.ping();
        this.startPongTimeout();
      }
    }, PING_INTERVAL_MS);
  }

  private stopPingInterval() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }

  private startPongTimeout() {
    this.clearPongTimeout();
    this.pongTimeout = setTimeout(() => {
      log("⚠️  Binance pong timeout — reconnecting");
      this.ws?.terminate();
    }, PONG_TIMEOUT_MS);
  }

  private clearPongTimeout() {
    if (this.pongTimeout) { clearTimeout(this.pongTimeout); this.pongTimeout = null; }
  }

  private startStaleCheck() {
    this.stopStaleCheck();
    this.staleCheckInterval = setInterval(() => {
      if (this.isClosing) return;
      const age = Date.now() - this.lastMessageTime;
      if (this.lastMessageTime > 0 && age > STALE_THRESHOLD_MS) {
        log(`⚠️  Binance stale (${age}ms) — reconnecting`);
        this.ws?.terminate();
      }
    }, STALE_CHECK_INTERVAL_MS);
  }

  private stopStaleCheck() {
    if (this.staleCheckInterval) { clearInterval(this.staleCheckInterval); this.staleCheckInterval = null; }
  }

  private cleanup() {
    this.stopPingInterval();
    this.clearPongTimeout();
    this.stopStaleCheck();
    this.ws = null;
  }

  private scheduleReconnect() {
    if (this.reconnectTimeout) return;
    log("Reconnecting to Binance in 3s...");
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, 3000);
  }

  getMidPrice(): MidPrice | null { return this.latestPrice; }

  close() {
    this.isClosing = true;
    if (this.reconnectTimeout) { clearTimeout(this.reconnectTimeout); this.reconnectTimeout = null; }
    this.cleanup();
    if (this.ws) { this.ws.close(); this.ws = null; }
  }
}

// ─── OrderlyFeed ───────────────────────────────────────────────────────────
// Polls Orderly orderbook every UPDATE_THROTTLE_MS to get local mid price
// Used together with Binance to calculate fair price offset

class OrderlyFeed {
  private latestPrice: MidPrice | null = null;

  constructor(private readonly signer: OrderlySigner) {}

  async poll(): Promise<void> {
    try {
      const r = await this.signer.request("GET", `/v1/orderbook/${SYMBOL}`, { max_level: 1 });
      const bids = r?.data?.bids;
      const asks = r?.data?.asks;
      if (!bids?.length || !asks?.length) return;
      // Orderly returns either [price, qty] arrays or {price, quantity} objects
      const bid = Array.isArray(bids[0]) ? parseFloat(bids[0][0]) : parseFloat(bids[0].price);
      const ask = Array.isArray(asks[0]) ? parseFloat(asks[0][0]) : parseFloat(asks[0].price);
      if (!bid || !ask || isNaN(bid) || isNaN(ask)) return;
      this.latestPrice = { mid: (bid + ask) / 2, bid, ask, timestamp: Date.now() };
    } catch (_) {}
  }

  getMidPrice(): MidPrice | null { return this.latestPrice; }
}

// ─── FairPriceCalculator ───────────────────────────────────────────────────
// Direct port of friend's fair-price.ts
// fair_price = binance_mid + median(orderly_mid - binance_mid) over windowMs
// This corrects for the spread between Orderly and Binance pricing

const MAX_SAMPLES = 500;

interface OffsetSample {
  offset: number; // orderly_mid - binance_mid
  second: number; // unix second
}

class FairPriceCalc {
  private samples:    OffsetSample[] = [];
  private head        = 0;
  private count       = 0;
  private lastSecond  = 0;

  // Add sample — one per second max (same as friend's implementation)
  addSample(orderlyMid: number, binanceMid: number): void {
    const currentSecond = Math.floor(Date.now() / 1000);
    if (currentSecond <= this.lastSecond) return;
    this.lastSecond = currentSecond;

    const offset = orderlyMid - binanceMid;
    this.samples[this.head] = { offset, second: currentSecond };
    this.head = (this.head + 1) % MAX_SAMPLES;
    if (this.count < MAX_SAMPLES) this.count++;
  }

  private getValidSamples(): OffsetSample[] {
    const cutoff = Math.floor((Date.now() - FAIR_PRICE_WINDOW_MS) / 1000);
    const valid: OffsetSample[] = [];
    for (let i = 0; i < this.count; i++) {
      if (this.samples[i]?.second > cutoff) valid.push(this.samples[i]);
    }
    return valid;
  }

  private medianOffset(samples: OffsetSample[]): number {
    const sorted = samples.map(s => s.offset).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  // Returns fair price only after WARMUP_SECONDS samples
  getFairPrice(binanceMid: number): number | null {
    const valid = this.getValidSamples();
    if (valid.length < WARMUP_SECONDS) return null;
    return binanceMid + this.medianOffset(valid);
  }

  getSampleCount(): number { return this.getValidSamples().length; }

  // For warmup display — shows offset even before minSamples reached
  getRawOffset(binanceMid: number): string {
    const valid = this.getValidSamples();
    if (valid.length === 0) return "--";
    const offset = this.medianOffset(valid);
    return ((offset / binanceMid) * 10000).toFixed(1) + " bps";
  }
}

// ─── VolatilityMeter ──────────────────────────────────────────────────────
// Measures realized volatility from 5min of fair price history
// Uses average absolute price change per minute (bps/min)
// Drives dynamic spread: low vol = tight spread, high vol = wide spread

type VolatilityLevel = "LOW" | "MID" | "HIGH";

class VolatilityMeter {
  private prices: { price: number; second: number }[] = [];

  addPrice(fairPrice: number): void {
    const second = Math.floor(Date.now() / 1000);
    this.prices.push({ price: fairPrice, second });
    // Keep only last 5min + buffer
    const cutoff = second - (VOL_WINDOW_MS / 1000 + 60);
    this.prices = this.prices.filter(p => p.second > cutoff);
  }

  // Realized volatility = std deviation of 1-second returns, annualized to bps/min
  getVolBps(): number | null {
    const cutoff = Math.floor((Date.now() - VOL_WINDOW_MS) / 1000);
    const valid = this.prices.filter(p => p.second > cutoff);
    if (valid.length < 10) return null;

    // Calculate 1-second absolute moves in bps
    const moves: number[] = [];
    for (let i = 1; i < valid.length; i++) {
      const move = Math.abs(valid[i].price - valid[i-1].price) / valid[i-1].price * 10000;
      moves.push(move);
    }
    if (moves.length === 0) return null;

    // Average absolute move per second × 60 = bps/min
    const avgMovePerSec = moves.reduce((a, b) => a + b, 0) / moves.length;
    return avgMovePerSec * 60;
  }

  getLevel(): VolatilityLevel {
    const vol = this.getVolBps();
    if (vol === null) return "MID"; // default until we have data
    if (vol < VOL_LOW_THRESHOLD)  return "LOW";
    if (vol < VOL_HIGH_THRESHOLD) return "MID";
    return "HIGH";
  }

  // Returns the effective spread bps based on current volatility
  getEffectiveSpread(): number {
    switch (this.getLevel()) {
      case "LOW":  return SPREAD_LOW_BPS;
      case "MID":  return SPREAD_BPS;
      case "HIGH": return SPREAD_HIGH_BPS;
    }
  }

  getInfo(): string {
    const vol   = this.getVolBps();
    const level = this.getLevel();
    const spread = this.getEffectiveSpread();
    const emoji = level === "LOW" ? "🟢" : level === "MID" ? "🟡" : "🔴";
    const volStr = vol !== null ? vol.toFixed(1) : "--";
    return `${emoji} ${level} vol (${volStr} bps/min) → spread ${spread} bps`;
  }
}

// ─── TrendDetector ────────────────────────────────────────────────────────
// Stores fair price history and computes trend over 15min and 1h windows
// Both windows must agree before trend is confirmed — avoids false signals
//
// UP trend:   15min > +THRESHOLD AND 1h > +THRESHOLD → SELL only
// DOWN trend: 15min < -THRESHOLD AND 1h < -THRESHOLD → BUY only
// RANGING:    disagreement or below threshold         → both sides

type TrendDirection = "UP" | "DOWN" | "RANGING";

interface PriceSample {
  price:  number;
  second: number;
}

class TrendDetector {
  private history: PriceSample[] = []; // rolling 1h of fair price samples

  // Called every time we have a valid fair price
  addPrice(fairPrice: number): void {
    const second = Math.floor(Date.now() / 1000);
    this.history.push({ price: fairPrice, second });
    // Keep only last 4h + buffer
    const cutoff = second - (4 * 3600 + 300);
    this.history = this.history.filter(s => s.second > cutoff);
  }

  // Get fair price N milliseconds ago (closest sample)
  private getPriceAgo(ms: number): number | null {
    const targetSecond = Math.floor((Date.now() - ms) / 1000);
    // Find closest sample to target time
    let closest: PriceSample | null = null;
    let minDiff = Infinity;
    for (const s of this.history) {
      const diff = Math.abs(s.second - targetSecond);
      if (diff < minDiff) { minDiff = diff; closest = s; }
    }
    // Only return if sample is within 60s of target
    if (!closest || minDiff > 60) return null;
    return closest.price;
  }

  // Calculate trend move in bps over a given window
  private getMovesBps(windowMs: number, currentPrice: number): number | null {
    const pastPrice = this.getPriceAgo(windowMs);
    if (!pastPrice) return null;
    return ((currentPrice - pastPrice) / pastPrice) * 10000;
  }

  getTrend(currentPrice: number): TrendDirection {
    const move15m = this.getMovesBps(TREND_15MIN_MS, currentPrice);
    const move1h  = this.getMovesBps(TREND_1H_MS,   currentPrice);
    const move4h  = this.getMovesBps(TREND_4H_MS,   currentPrice);

    // Need at least 15min and 1h to have data
    if (move15m === null || move1h === null) return "RANGING";

    const isUp15m   = move15m >  TREND_THRESHOLD_BPS;
    const isDown15m = move15m < -TREND_THRESHOLD_BPS;
    const isUp1h    = move1h  >  TREND_THRESHOLD_BPS;
    const isDown1h  = move1h  < -TREND_THRESHOLD_BPS;

    // 4h is optional (only available after 4h of running)
    // If available, ALL THREE must agree for trend confirmation
    // If not yet available, 15min + 1h agreement is enough
    if (move4h !== null) {
      const isUp4h   = move4h >  TREND_THRESHOLD_BPS;
      const isDown4h = move4h < -TREND_THRESHOLD_BPS;
      if (isUp15m   && isUp1h   && isUp4h)   return "UP";
      if (isDown15m && isDown1h && isDown4h) return "DOWN";
    } else {
      // Fallback: 15min + 1h only (first 4h of running)
      if (isUp15m   && isUp1h)   return "UP";
      if (isDown15m && isDown1h) return "DOWN";
    }
    return "RANGING";
  }

  // For status display
  getInfo(currentPrice: number): string {
    const move15m = this.getMovesBps(TREND_15MIN_MS, currentPrice);
    const move1h  = this.getMovesBps(TREND_1H_MS,   currentPrice);
    const move4h  = this.getMovesBps(TREND_4H_MS,   currentPrice);
    const trend   = this.getTrend(currentPrice);
    const emoji   = trend === "UP" ? "📈" : trend === "DOWN" ? "📉" : "➡️";
    const h4str   = move4h !== null ? move4h.toFixed(1) : "--";
    return `${emoji} ${trend} | 15m: ${move15m?.toFixed(1) ?? "--"} bps | 1h: ${move1h?.toFixed(1) ?? "--"} bps | 4h: ${h4str} bps`;
  }

  hasEnoughData(): boolean {
    return this.getPriceAgo(TREND_15MIN_MS) !== null;
  }
}

// ─── PositionTracker ───────────────────────────────────────────────────────
// Direct port of friend's position.ts
// Optimistic updates on fill + periodic server sync to prevent drift

class PositionTracker {
  private qty = 0; // positive = long, negative = short

  applyFill(side: "BUY" | "SELL", size: number): void {
    this.qty += side === "BUY" ? size : -size;
    log(`📊 Fill applied: ${side} ${size} → position ${this.qty.toFixed(6)} BTC`);
  }

  async syncFromServer(signer: OrderlySigner): Promise<void> {
    try {
      const r = await signer.request("GET", `/v1/position/${SYMBOL}`);
      const serverQty = parseFloat(r?.data?.position_qty) || 0;
      if (Math.abs(this.qty - serverQty) > 0.0001) {
        log(`⚠️  Position drift: local=${this.qty.toFixed(6)}, server=${serverQty.toFixed(6)} — correcting`);
        this.qty = serverQty;
      }
    } catch (_) {}
  }

  getQty():   number  { return this.qty; }
  getUsd(fp: number): number { return Math.abs(this.qty) * fp; }
  isLong():   boolean { return this.qty > 0; }

  isCloseMode(fp: number): boolean {
    return this.getUsd(fp) >= CLOSE_THRESHOLD && Math.abs(this.qty) >= 0.001;
  }

  // Mirrors friend's getAllowedSides()
  allowedSides(fp: number): ("BUY" | "SELL")[] {
    if (!this.isCloseMode(fp)) return ["BUY", "SELL"];
    return this.isLong() ? ["SELL"] : ["BUY"];
  }
}

// ─── Quoter ────────────────────────────────────────────────────────────────
// Direct port of friend's quoter.ts
// Calculates bid/ask prices from fair price

interface Quote {
  side:  "BUY" | "SELL";
  price: number;
  qty:   number;
}

class Quoter {
  getQuotes(
    fairPrice: number,
    allowedSides: ("BUY" | "SELL")[],
    isCloseMode: boolean,
    posQty: number,
    effectiveSpread: number = SPREAD_BPS,
  ): Quote[] {
    const bps    = isCloseMode ? TAKE_PROFIT_BPS : effectiveSpread;
    const spread = (bps / 10000) * fairPrice;
    const quotes: Quote[] = [];

    for (const side of allowedSides) {
      // In close mode: size = exact position size (mirrors friend's quoter)
      // In open mode:  size = ORDER_SIZE_USD / fair_price
      const qty = isCloseMode
        ? round(Math.abs(posQty), 3)
        : round(ORDER_SIZE_USD / fairPrice, 3);

      if (qty < 0.001) continue;

      // BUY below fair, SELL above fair
      const price = side === "BUY"
        ? round(fairPrice - spread, 1)
        : round(fairPrice + spread, 1);

      quotes.push({ side, price, qty });
    }

    return quotes;
  }
}

// ─── MarketMaker ───────────────────────────────────────────────────────────
// Main bot — mirrors friend's index.ts (MarketMaker class)

interface CachedOrder {
  id:    number;
  side:  "BUY" | "SELL";
  price: number;
  qty:   number;
}

class MarketMaker {
  private signer   = new OrderlySigner(ACCOUNT_ID, SECRET, PUBLIC_KEY);
  private binance  = new BinanceFeed();
  private orderly  = new OrderlyFeed(new OrderlySigner(ACCOUNT_ID, SECRET, PUBLIC_KEY));
  private fairCalc = new FairPriceCalc();
  private position = new PositionTracker();
  private quoter   = new Quoter();

  private activeOrders: CachedOrder[] = [];
  private stopping    = false;
  private isUpdating  = false; // lock to prevent concurrent updates
  private trendDetector = new TrendDetector();
  private volMeter      = new VolatilityMeter();
  private currentTrend: TrendDirection = "RANGING";
  private readonly botStartTime = Date.now();
  private lastUpdateAt = 0;

  // ── Orderly REST helpers ─────────────────────────────────────────────────

  private async placeOrder(side: "BUY" | "SELL", price: number, qty: number): Promise<number | null> {
    if (DRY_RUN) {
      log(`  [DRY] ${side} POST_ONLY $${price} qty=${qty}`);
      return Date.now(); // fake ID
    }
    try {
      const r = await this.signer.request("POST", "/v1/order", {}, {
        symbol: SYMBOL, order_type: "POST_ONLY",
        side, order_price: price, order_quantity: qty,
      });
      if (r?.success) {
        log(`  ✅ ${side} POST_ONLY  id=${r.data.order_id}  $${price}  qty=${qty}`);
        return r.data.order_id;
      }
      log(`  ⚠️  Rejected: ${JSON.stringify(r?.message || r)}`);
    } catch (e: any) { log(`  ❌ ${e.response?.data?.message || e.message}`); }
    return null;
  }

  private async cancelOrder(id: number): Promise<void> {
    if (DRY_RUN) return;
    try {
      await this.signer.request("DELETE", "/v1/order", { order_id: id, symbol: SYMBOL });
      log(`  🗑️  Cancelled id=${id}`);
    } catch (_) {}
  }

  private async cancelAll(): Promise<void> {
    await Promise.all(this.activeOrders.map(o => this.cancelOrder(o.id)));
    this.activeOrders = [];
  }

  private async cancelAllOnExchange(): Promise<void> {
    if (DRY_RUN) return;
    try {
      await this.signer.request("DELETE", "/v1/orders", { symbol: SYMBOL });
      log("🧹 All orders cancelled");
    } catch (_) {}
  }

  // ── updateQuotes — mirrors friend's updateQuotes() ───────────────────────
  // Strategy: cancel ALL stale orders on exchange, then place fresh quotes
  // This prevents order accumulation from silent cancel failures

  private async updateQuotes(fairPrice: number): Promise<void> {
    if (this.stopping) return;
    if (this.isUpdating) return; // skip if already updating
    this.isUpdating = true;
    try {
      await this._updateQuotes(fairPrice);
    } finally {
      this.isUpdating = false;
    }
  }

  private async _updateQuotes(fairPrice: number): Promise<void> {
    if (this.stopping) return;

    // Feed price into volatility meter and trend detector
    this.volMeter.addPrice(fairPrice);
    this.trendDetector.addPrice(fairPrice);
    this.currentTrend = this.trendDetector.getTrend(fairPrice);

    // Get allowed sides from position tracker, then filter by trend
    let sides = this.position.allowedSides(fairPrice);
    const isClose = this.position.isCloseMode(fairPrice);

    // Apply trend filter only in OPEN mode (never restrict closing orders)
    // Also only activate after TREND_ACTIVATION_MS (2h) of runtime
    const uptimeMs = Date.now() - this.botStartTime;
    const trendActive = !isClose
      && uptimeMs >= TREND_ACTIVATION_MS
      && this.trendDetector.hasEnoughData();

    if (trendActive) {
      if (this.currentTrend === "UP") {
        sides = ["SELL"]; // only sell into the pump
        log(`📈 Trend UP — SELL only`);
      } else if (this.currentTrend === "DOWN") {
        sides = ["BUY"];  // only buy into the dip
        log(`📉 Trend DOWN — BUY only`);
      }
    }

    const posQty         = this.position.getQty();
    const effectiveSpread = isClose ? TAKE_PROFIT_BPS : this.volMeter.getEffectiveSpread();
    const quotes  = this.quoter.getQuotes(fairPrice, sides, isClose, posQty, effectiveSpread);

    // Only requote if price moved more than MIN_REQUOTE_BPS (5 bps = half our spread)
    // This prevents constant cancel/replace on tiny price moves
    // With 10 bps spread, we requote when fair moves >5 bps = $35 on $70k BTC
    const MIN_REQUOTE_BPS = 5;
    const needsUpdate = quotes.some(q => {
      const existing = this.activeOrders.find(o => o.side === q.side);
      if (!existing) return true; // missing order, need to place
      const priceDiff = Math.abs(existing.price - q.price) / existing.price * 10000;
      return priceDiff >= MIN_REQUOTE_BPS || existing.qty !== q.qty;
    });

    // Also check if we have orders for sides no longer needed
    const hasStaleSides = this.activeOrders.some(o => !quotes.some(q => q.side === o.side));

    if (!needsUpdate && !hasStaleSides) return;

    // Cancel ALL orders on exchange then place fresh quotes
    await this.cancelAllOnExchange();
    this.activeOrders = [];

    // Place fresh quotes
    for (const q of quotes) {
      const id = await this.placeOrder(q.side, q.price, q.qty);
      if (id !== null) {
        this.activeOrders.push({ id, side: q.side, price: q.price, qty: q.qty });
      }
    }
  }

  // ── syncOrders — mirrors friend's orderSyncInterval ──────────────────────
  // Fetches live orders from exchange every ORDER_SYNC_INTERVAL_MS
  // Detects fills by comparing tracked orders vs live orders

  private async syncOrders(fairPrice: number): Promise<void> {
    if (DRY_RUN || this.stopping || this.isUpdating) return;
    try {
      const r = await this.signer.request("GET", "/v1/orders", {
        symbol: SYMBOL, status: "INCOMPLETE",
      });
      const liveIds = new Set((r?.data?.rows || []).map((o: any) => o.order_id));

      for (const tracked of [...this.activeOrders]) {
        if (!liveIds.has(tracked.id)) {
          // Order no longer live → fill detected
          log(`🎯 Fill detected: ${tracked.side} id=${tracked.id} @ $${tracked.price}`);
          this.position.applyFill(tracked.side, tracked.qty);
          this.activeOrders = this.activeOrders.filter(o => o.id !== tracked.id);

          // Entering close mode → immediately cancel all other orders
          if (this.position.isCloseMode(fairPrice)) {
            log("🔄 Entering CLOSE mode — cancelling remaining orders");
            await this.cancelAll();
          }
        }
      }
    } catch (_) {}
  }

  // ── logStatus — mirrors friend's statusInterval ───────────────────────────

  private logStatus(fairPrice: number): void {
    if (this.stopping) return;
    const isClose  = this.position.isCloseMode(fairPrice);
    const mode     = isClose ? "CLOSE" : "OPEN";
    const qty      = this.position.getQty().toFixed(6);
    const usd      = this.position.getUsd(fairPrice).toFixed(2);
    const orders   = this.activeOrders.map(o => `${o.side}@${o.price}`).join(", ") || "none";
    const trend    = this.trendDetector.getInfo(fairPrice);
    const uptimeMs = Date.now() - this.botStartTime;
    const uptimeMin = Math.floor(uptimeMs / 60000);
    const filterState = uptimeMs < TREND_ACTIVATION_MS
      ? `⏳ filter in ${Math.ceil((TREND_ACTIVATION_MS - uptimeMs) / 60000)}min`
      : "✅ filter ON";
    const vol = this.volMeter.getInfo();
    log(`[${mode}] fair=$${fairPrice.toFixed(1)} | pos=${qty} BTC ($${usd}) | ${trend} | ${vol} | ${filterState} | orders=[${orders}]`);
  }

  // ── Shutdown ─────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    log("\n🛑 Shutting down...");
    await this.cancelAllOnExchange();
    await this.position.syncFromServer(this.signer);
    const qty = this.position.getQty();
    if (Math.abs(qty) < 0.001) {
      log("✅ No position. Goodbye! 👋");
    } else {
      log(`⚠️  Open position: ${qty} BTC — close manually on PerpTools!`);
    }
    this.binance.close();
    process.exit(0);
  }

  // ── Run ──────────────────────────────────────────────────────────────────

  async run(): Promise<void> {
    if (!ACCOUNT_ID || !PUBLIC_KEY || !SECRET || SECRET === "PASTE_YOUR_SECRET_HERE") {
      throw new Error("❌ Missing credentials in .env");
    }

    log("=".repeat(60));
    log(`  Orderly Market Maker v9`);
    log(`  Symbol     : ${SYMBOL}`);
    log(`  Spread     : ${SPREAD_LOW_BPS}/${SPREAD_BPS}/${SPREAD_HIGH_BPS} bps (low/mid/high vol) / ${TAKE_PROFIT_BPS} bps close`);
    log(`  Vol thresh : low<${VOL_LOW_THRESHOLD} mid<${VOL_HIGH_THRESHOLD} bps/min (5min window)`);
    log(`  Order size : $${ORDER_SIZE_USD}`);
    log(`  Close at   : $${CLOSE_THRESHOLD} position`);
    log(`  Fair price : Binance + median(Orderly offset, ${FAIR_PRICE_WINDOW_MS/1000}s window)`);
    log(`  Trend      : 15min+1h+4h momentum | threshold: ${TREND_THRESHOLD_BPS} bps`);
    log(`  Schedule   : 0-2h = both sides always | 2h+ = trend filter ON | 4h+ = 4h window added`);
    log(`  DRY RUN    : ${DRY_RUN}`);
    log("=".repeat(60));

    process.on("SIGINT",  () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());

    // Start Binance feed
    // When Binance price arrives AND Orderly price is available → add sample to fair price calc
    this.binance.onPrice = async (binancePrice) => {
      const orderlyPrice = this.orderly.getMidPrice();
      if (orderlyPrice && Math.abs(binancePrice.timestamp - orderlyPrice.timestamp) < 1000) {
        this.fairCalc.addSample(orderlyPrice.mid, binancePrice.mid);
      }

      if (this.stopping) return;

      const fairPrice = this.fairCalc.getFairPrice(binancePrice.mid);
      if (!fairPrice) return; // still warming up

      // Throttle updates to UPDATE_THROTTLE_MS (mirrors friend's throttle)
      const now = Date.now();
      if (now - this.lastUpdateAt < UPDATE_THROTTLE_MS) return;
      this.lastUpdateAt = now;

      await this.updateQuotes(fairPrice);
    };

    this.binance.connect();

    // ── Warmup ──
    log(`⏳ Warming up — need ${WARMUP_SECONDS} samples...`);
    let orderlyFails = 0;
    while (true) {
      await this.orderly.poll();
      const binance = this.binance.getMidPrice();
      const orderly = this.orderly.getMidPrice();

      if (binance && orderly) {
        this.fairCalc.addSample(orderly.mid, binance.mid);
        orderlyFails = 0;
      } else if (binance) {
        orderlyFails++;
        if (orderlyFails >= 15) {
          this.fairCalc.addSample(binance.mid, binance.mid);
        }
      }

      const samples   = this.fairCalc.getSampleCount();
      const offsetStr = binance ? this.fairCalc.getRawOffset(binance.mid) : "--";
      process.stdout.write(
        `\r  Samples: ${samples}/${WARMUP_SECONDS} | ` +
        `Binance: $${binance?.mid.toFixed(1) ?? "--"} | ` +
        `Orderly: $${orderly?.mid.toFixed(1) ?? "--"} | ` +
        `Offset: ${offsetStr}   `
      );

      if (samples >= WARMUP_SECONDS) break;
      await sleep(1000);
    }
    console.log();

    const binanceMid  = this.binance.getMidPrice()!.mid;
    const fairPrice   = this.fairCalc.getFairPrice(binanceMid) ?? binanceMid;
    log(`✅ Ready — fair price $${fairPrice.toFixed(1)}`);

    // Clear any leftover orders
    await this.cancelAllOnExchange();

    // Sync initial position
    await this.position.syncFromServer(this.signer);
    log(`📐 Position: ${this.position.getQty().toFixed(6)} BTC (~$${this.position.getUsd(fairPrice).toFixed(2)})`);

    log("🚀 Bot running!\n");

    // ── Periodic intervals (mirrors friend's startIntervals) ──

    // Position sync every POSITION_SYNC_MS
    setInterval(async () => {
      if (!this.stopping) await this.position.syncFromServer(this.signer);
    }, POSITION_SYNC_MS);

    // Order sync / fill detection every ORDER_SYNC_INTERVAL_MS
    setInterval(async () => {
      const b = this.binance.getMidPrice();
      if (b && !this.stopping) {
        const fp = this.fairCalc.getFairPrice(b.mid);
        if (fp) await this.syncOrders(fp);
      }
    }, ORDER_SYNC_INTERVAL_MS);

    // Orderly orderbook polling (for fair price offset samples)
    setInterval(async () => {
      if (!this.stopping) await this.orderly.poll();
    }, 1000);

    // Status display every STATUS_INTERVAL_MS
    setInterval(() => {
      const b = this.binance.getMidPrice();
      if (b && !this.stopping) {
        const fp = this.fairCalc.getFairPrice(b.mid);
        if (fp) this.logStatus(fp);
      }
    }, STATUS_INTERVAL_MS);

    // Keep alive
    await new Promise<void>(() => {});
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────

new MarketMaker().run().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});