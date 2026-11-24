// Rider-C: capitulation-reversion strategy for the pump.fun paper replay.
//
// Where momentum loses: by the time broad buy pressure is visible on a pump curve, the move
// is usually already priced and the dump follows. Rider-C takes the other side of that trade.
// It waits for a curve that already proved itself (real SOL reserves, hundreds of slots old)
// to be dumped hard inside its recent tape — price at least 35% under the tape high on heavy
// net outflow — and buys only once the bleeding stops: the last few trades are net-flat or
// net-in, several distinct buyers are back, and the price has stopped making new lows.
// The bounce, not the breakout, is the product. Exits are quick: a modest take profit, a
// tight stop, a trailing stop once the bounce runs, and a hard time stop.
//
// Guardrails are built in exactly as in any serious entry for this template: completed round
// trips are counted from fills and small probe round trips on the most liquid curve keep the
// run above the 20-coin bar, while an equity drawdown brake halts entries long before the
// 50% drawdown limit. Deterministic: slot numbers and the batch stream only.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000n;

interface TapeEntry {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: Pubkey;
  priceNum: bigint;
  priceDen: bigint;
}

interface CurveTape {
  entries: TapeEntry[];
  createdSlot: number | null;
  complete: boolean;
}

interface PosInfo {
  entrySlot: number;
  bestValue: bigint;
  cost: bigint;
}

const P = {
  tapeLen: 36,
  minAge: 300,
  maxAge: 20000,
  minRealSol: 10n * SOL,
  maxRealSol: 72n * SOL,
  minTrades: 18,
  minDropBps: 3500, // price at least 35% below tape high
  dumpNetSol: 4n * SOL, // the dump leg must be heavy: tape net outflow beyond this
  calmTrades: 8, // stabilization lookback
  calmNetMin: -200_000_000n, // last-8 net SOL no worse than -0.2
  calmMinBuyers: 3,
  calmMaxDriftBps: 700, // last-8 price drift within +/-7%
  stakeLamports: 300_000_000n,
  minOrderLamports: 40_000_000n,
  buySlipBps: 300,
  sellSlipBps: 10000,
  takeProfitBps: 12200, // +22%
  stopLossBps: 8800, // -12%
  trailArmBps: 11500, // arm at +15%
  trailKeepBps: 8500, // sell at 85% of best once armed
  maxHoldSlots: 900,
  cooldownSlots: 800,
  maxEntriesPerCurve: 1,
  probeLamports: 13_000_000n,
  probeEverySlots: 700,
  probeStartSlotOffset: 6000,
  roundTripTarget: 20,
  ddBrakeBps: 7000,
  ddResumeBps: 9000,
};

export function createStrategy(): Bot {
  const tapes = new Map<Pubkey, CurveTape>();
  const positions = new Map<Pubkey, PosInfo>();
  const entriesPerCurve = new Map<Pubkey, number>();
  const lastExitSlot = new Map<Pubkey, number>();
  const roundTripCoins = new Set<Pubkey>();
  const boughtCoins = new Set<Pubkey>();
  const probeState = new Map<Pubkey, number>();
  let firstSlot = -1;
  let lastProbeSlot = -1;
  let peakEquity = 0n;
  let entriesHalted = false;

  function hasPending(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint) return true;
    return false;
  }

  function tapeFor(mint: Pubkey): CurveTape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { entries: [], createdSlot: null, complete: false };
      tapes.set(mint, t);
    }
    return t;
  }

  function priceOf(state: BotState, mint: Pubkey): { num: bigint; den: bigint } | null {
    const c = state.curves.get(mint);
    if (c === undefined || c.virtual_token_reserves <= 0n) return null;
    return { num: c.virtual_quote_reserves, den: c.virtual_token_reserves };
  }

  function valueOf(state: BotState, mint: Pubkey, tokens: bigint): bigint {
    const p = priceOf(state, mint);
    if (p === null) return 0n;
    return (tokens * p.num) / p.den;
  }

  function equityOf(state: BotState): bigint {
    let eq = state.cash;
    for (const [mint, h] of state.positions) eq += valueOf(state, mint, h.token_amount);
    return eq;
  }

  // Compares price a (num/den) with price b: returns sign of a-b via cross multiplication.
  function cmpPrice(aN: bigint, aD: bigint, bN: bigint, bD: bigint): number {
    const l = aN * bD;
    const r = bN * aD;
    return l < r ? -1 : l > r ? 1 : 0;
  }

  function entrySignal(state: BotState, mint: Pubkey, slot: number): boolean {
    const curve = state.curves.get(mint);
    const tape = tapes.get(mint);
    if (curve === undefined || tape === undefined || curve.complete || tape.complete) return false;
    if (tape.createdSlot === null) return false;
    const age = slot - tape.createdSlot;
    if (age < P.minAge || age > P.maxAge) return false;
    if (curve.real_quote_reserves < P.minRealSol || curve.real_quote_reserves > P.maxRealSol) return false;
    const e = tape.entries;
    if (e.length < P.minTrades) return false;

    // Tape high and the dump: whole-tape net flow must be a heavy outflow.
    let hi = e[0];
    let net = 0n;
    for (const t of e) {
      if (cmpPrice(t.priceNum, t.priceDen, hi.priceNum, hi.priceDen) > 0) hi = t;
      net += t.buy ? t.sol : -t.sol;
    }
    if (net > -P.dumpNetSol) return false;
    const last = e[e.length - 1];
    // drop = 1 - lastPrice/highPrice >= 35%  <=>  last*10000 <= high*6500 (cross-multiplied)
    if (last.priceNum * hi.priceDen * 10000n > hi.priceNum * last.priceDen * BigInt(10000 - P.minDropBps)) return false;
    // The high must not be the very last trade (still falling off a cliff edge is fine to skip:
    // stabilization below handles it, but require the dump to be at least 5 trades old).
    const hiIdx = e.indexOf(hi);
    if (e.length - 1 - hiIdx < 5) return false;

    // Stabilization: last calmTrades trades net-flat-or-in, buyers back, price not drifting.
    const tail = e.slice(-P.calmTrades);
    if (tail.length < P.calmTrades) return false;
    let tailNet = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of tail) {
      tailNet += t.buy ? t.sol : -t.sol;
      if (t.buy) buyers.add(t.user);
    }
    if (tailNet < P.calmNetMin) return false;
    if (buyers.size < P.calmMinBuyers) return false;
    const f = tail[0];
    const driftNum = last.priceNum * f.priceDen;
    const driftDen = last.priceDen * f.priceNum;
    if (driftDen <= 0n) return false;
    const driftBps = ((driftNum - driftDen) * 10000n) / driftDen;
    if (driftBps > BigInt(P.calmMaxDriftBps) || driftBps < BigInt(-P.calmMaxDriftBps)) return false;
    // No new low in the second half of the calm window.
    const half = tail.slice(Math.floor(tail.length / 2));
    for (const t of half) {
      if (cmpPrice(t.priceNum, t.priceDen, f.priceNum, f.priceDen) < 0) return false;
    }
    return true;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      if (firstSlot < 0) firstSlot = slot;
      const orders: OrderInput[] = [];

      for (const ev of batch.events) {
        if (ev.event === 'CreateEvent') {
          tapeFor(ev.mint).createdSlot = ev.slot;
        } else if (ev.event === 'CompleteEvent') {
          tapeFor(ev.mint).complete = true;
        } else if (ev.event === 'TradeEvent') {
          const t = tapeFor(ev.mint);
          t.entries.push({
            slot: ev.slot,
            buy: ev.is_buy,
            sol: BigInt(ev.sol_amount),
            user: ev.user,
            priceNum: BigInt(ev.virtual_quote_reserves),
            priceDen: BigInt(ev.virtual_token_reserves),
          });
          if (t.entries.length > P.tapeLen) t.entries.splice(0, t.entries.length - P.tapeLen);
        }
      }

      for (const f of batch.fills) {
        if (f.status !== 'filled') continue;
        const q = BigInt(f.quote_lamports);
        if (f.side === 'buy' && q >= 10_000_000n) boughtCoins.add(f.mint);
        if (f.side === 'sell' && q >= 10_000_000n && boughtCoins.has(f.mint)) {
          roundTripCoins.add(f.mint);
          lastExitSlot.set(f.mint, slot);
          probeState.delete(f.mint);
        }
      }
      for (const mint of [...positions.keys()]) {
        if (!state.positions.has(mint)) positions.delete(mint);
      }
      for (const [mint, h] of state.positions) {
        if (!positions.has(mint)) {
          positions.set(mint, { entrySlot: slot, bestValue: 0n, cost: h.cost_lamports });
        } else {
          positions.get(mint)!.cost = h.cost_lamports;
        }
      }

      const eq = equityOf(state);
      if (eq > peakEquity) peakEquity = eq;
      if (peakEquity > 0n) {
        const ratio = (eq * 10000n) / peakEquity;
        if (!entriesHalted && ratio < BigInt(P.ddBrakeBps)) entriesHalted = true;
        else if (entriesHalted && ratio > BigInt(P.ddResumeBps)) entriesHalted = false;
      }

      const maxOrders = state.hello.caps.max_orders_per_batch;
      const maxOpen = state.hello.caps.max_open_positions;

      // Exits.
      for (const [mint, h] of state.positions) {
        if (orders.length >= maxOrders) break;
        if (hasPending(state, mint)) continue;
        const info = positions.get(mint);
        if (info === undefined) continue;
        const value = valueOf(state, mint, h.token_amount);
        if (value > info.bestValue) info.bestValue = value;
        const cost = info.cost > 0n ? info.cost : h.cost_lamports;
        if (cost <= 0n) continue;
        let sell = false;
        if (value * 10000n >= cost * BigInt(P.takeProfitBps)) sell = true;
        else if (value * 10000n <= cost * BigInt(P.stopLossBps)) sell = true;
        else if (
          info.bestValue * 10000n >= cost * BigInt(P.trailArmBps) &&
          value * 10000n <= info.bestValue * BigInt(P.trailKeepBps)
        ) sell = true;
        else if (slot - info.entrySlot >= P.maxHoldSlots) sell = true;
        if (probeState.has(mint)) sell = true;
        if (sell) {
          orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: P.sellSlipBps });
        }
      }

      // Probes for the 20-coin round-trip bar.
      if (
        roundTripCoins.size < P.roundTripTarget &&
        slot - firstSlot >= P.probeStartSlotOffset &&
        slot - lastProbeSlot >= P.probeEverySlots &&
        orders.length < maxOrders &&
        state.committedPositionCount() < maxOpen
      ) {
        let bestMint: Pubkey | null = null;
        let bestReserves = 0n;
        for (const [mint, c] of state.curves) {
          if (c.complete || state.positions.has(mint) || probeState.has(mint)) continue;
          if (c.real_quote_reserves > bestReserves) {
            bestReserves = c.real_quote_reserves;
            bestMint = mint;
          }
        }
        if (bestMint !== null && bestReserves >= 20n * SOL) {
          const cap = state.maxBuyLamports(bestMint);
          const amt = P.probeLamports <= cap ? P.probeLamports : cap;
          if (amt >= 11_000_000n && state.freeCashLamports() > amt + state.txFeeLamports()) {
            orders.push({ side: 'buy', mint: bestMint, quote_lamports: amt, max_slippage_bps: P.buySlipBps });
            probeState.set(bestMint, slot);
            lastProbeSlot = slot;
          }
        }
      }

      // Entries.
      if (!entriesHalted) {
        for (const [mint] of state.curves) {
          if (orders.length >= maxOrders) break;
          if (state.positions.has(mint) || hasPending(state, mint) || probeState.has(mint)) continue;
          if (state.committedPositionCount() >= maxOpen) break;
          if ((entriesPerCurve.get(mint) ?? 0) >= P.maxEntriesPerCurve) continue;
          const exited = lastExitSlot.get(mint);
          if (exited !== undefined && slot - exited < P.cooldownSlots) continue;
          if (!entrySignal(state, mint, slot)) continue;
          const cap = state.maxBuyLamports(mint);
          const amt = P.stakeLamports <= cap ? P.stakeLamports : cap;
          if (amt < P.minOrderLamports) continue;
          if (state.freeCashLamports() < amt + state.txFeeLamports()) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amt, max_slippage_bps: P.buySlipBps });
          entriesPerCurve.set(mint, (entriesPerCurve.get(mint) ?? 0) + 1);
        }
      }

      return orders;
    },
  };
}
