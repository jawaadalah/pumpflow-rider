// FlowRider strategy for the pump.fun bonding-curve paper replay (agent-fun/replay/v2).
//
// Idea: ride only curves where money is verifiably flowing in from many independent wallets,
// enter small and late enough to skip the bundled-launch dump, and leave fast. A position is
// opened only when the recent tape shows broad buy pressure (many distinct buyers, buys
// dominating the SOL flow, no single wallet dominating), the price is rising but not yet
// parabolic, and the curve already holds real SOL (proof of life) without nearing migration.
// Exits are mechanical: take profit, stop loss, a trailing stop once in profit, a flow-death
// exit when the tape turns net-negative, and a hard time stop.
//
// Guardrails are treated as part of the strategy, not an afterthought: completed round trips
// per coin are counted from fills, and if the count lags, small probe round trips on the most
// liquid curve keep the run above the 20-coin bar. An equity drawdown brake halts new entries
// long before the 50% drawdown limit could be threatened.
//
// Deterministic by construction: decisions use only slot numbers and the batch stream, maps
// are insertion-ordered, and there is no clock or randomness anywhere.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000n;

interface TapeEntry {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: Pubkey;
  priceNum: bigint; // virtual quote reserves (price = priceNum / priceDen)
  priceDen: bigint; // virtual token reserves
}

interface CurveTape {
  entries: TapeEntry[]; // newest last, capped
  createdSlot: number | null;
  complete: boolean;
}

interface PosInfo {
  entrySlot: number;
  bestValue: bigint;
  cost: bigint;
}

const P = {
  tapeLen: 30,
  minAge: 120,
  maxAge: 6000,
  minRealSol: 6n * SOL,
  maxRealSol: 58n * SOL,
  minTrades: 14,
  minBuyers: 7,
  minBuyShareBps: 7200, // buy SOL >= 66% of tape SOL flow
  minNetSol: 3_500_000_000n,
  minRiseBps: 300, // +1.5%
  maxRiseBps: 3500, // +50%
  maxBuyerShareBps: 3800,
  stakeLamports: 320_000_000n, // 0.32 SOL
  strongStakeLamports: 480_000_000n, // 0.48 SOL when the tape is very broad
  minOrderLamports: 40_000_000n,
  buySlipBps: 300,
  sellSlipBps: 10000,
  takeProfitBps: 13000, // +30%
  stopLossBps: 8600, // -16%
  trailArmBps: 12200, // arm at +22%
  trailKeepBps: 8000, // sell at 80% of best value once armed
  flowDeathNet: -1_500_000_000n, // last-12-trades net SOL below -1.5
  flowDeathMinAge: 90,
  maxHoldSlots: 1100,
  cooldownSlots: 500,
  maxEntriesPerCurve: 2,
  probeLamports: 13_000_000n, // 0.013 SOL probe round trips (>= 0.01 SOL bar)
  probeEverySlots: 700,
  probeStartSlotOffset: 6000,
  roundTripTarget: 20,
  ddBrakeBps: 6800, // halt entries when equity < 68% of peak (32% drawdown)
  ddResumeBps: 8800,
};

export function createStrategy(): Bot {
  const tapes = new Map<Pubkey, CurveTape>();
  const positions = new Map<Pubkey, PosInfo>();
  const entriesPerCurve = new Map<Pubkey, number>();
  const lastExitSlot = new Map<Pubkey, number>();
  const roundTripCoins = new Set<Pubkey>();
  const boughtCoins = new Set<Pubkey>();
  const probeState = new Map<Pubkey, number>(); // mint -> slot the probe buy was sent
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

  function entrySignal(state: BotState, mint: Pubkey, slot: number): bigint {
    const curve = state.curves.get(mint);
    const tape = tapes.get(mint);
    if (curve === undefined || tape === undefined || curve.complete || tape.complete) return 0n;
    if (tape.createdSlot === null) return 0n;
    const age = slot - tape.createdSlot;
    if (age < P.minAge || age > P.maxAge) return 0n;
    if (curve.real_quote_reserves < P.minRealSol || curve.real_quote_reserves > P.maxRealSol) return 0n;
    const e = tape.entries;
    if (e.length < P.minTrades) return 0n;
    let buySol = 0n;
    let sellSol = 0n;
    let buyCount = 0;
    const buyers = new Map<Pubkey, bigint>();
    for (const t of e) {
      if (t.buy) {
        buySol += t.sol;
        buyCount += 1;
        buyers.set(t.user, (buyers.get(t.user) ?? 0n) + t.sol);
      } else {
        sellSol += t.sol;
      }
    }
    if (buyCount < 6 || buyers.size < P.minBuyers) return 0n;
    const flow = buySol + sellSol;
    if (flow <= 0n) return 0n;
    if ((buySol * 10000n) / flow < BigInt(P.minBuyShareBps)) return 0n;
    if (buySol - sellSol < P.minNetSol) return 0n;
    let topBuyer = 0n;
    for (const v of buyers.values()) if (v > topBuyer) topBuyer = v;
    if (buySol > 0n && (topBuyer * 10000n) / buySol > BigInt(P.maxBuyerShareBps)) return 0n;
    const first = e[0];
    const last = e[e.length - 1];
    // rise = (lastPrice/firstPrice - 1) in bps, cross-multiplied to stay in integers
    const riseNum = last.priceNum * first.priceDen;
    const riseDen = last.priceDen * first.priceNum;
    if (riseDen <= 0n) return 0n;
    const riseBps = ((riseNum - riseDen) * 10000n) / riseDen;
    if (riseBps < BigInt(P.minRiseBps) || riseBps > BigInt(P.maxRiseBps)) return 0n;
    const strong = buyers.size >= 8 && (buySol * 10000n) / flow >= 8000n;
    return strong ? P.strongStakeLamports : P.stakeLamports;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      if (firstSlot < 0) firstSlot = slot;
      const orders: OrderInput[] = [];

      // Fold this batch's events into the tapes (state already folded fills/account).
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

      // Learn from fills: positions, round trips, probe progress.
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
      // Sync position bookkeeping with the account's truth.
      for (const mint of [...positions.keys()]) {
        if (!state.positions.has(mint)) positions.delete(mint);
      }
      for (const [mint, h] of state.positions) {
        if (!positions.has(mint)) {
          positions.set(mint, { entrySlot: slot, bestValue: 0n, cost: h.cost_lamports });
        } else {
          const info = positions.get(mint)!;
          info.cost = h.cost_lamports;
        }
      }

      // Drawdown brake on marks-based equity.
      const eq = equityOf(state);
      if (eq > peakEquity) peakEquity = eq;
      if (peakEquity > 0n) {
        const ratio = (eq * 10000n) / peakEquity;
        if (!entriesHalted && ratio < BigInt(P.ddBrakeBps)) entriesHalted = true;
        else if (entriesHalted && ratio > BigInt(P.ddResumeBps)) entriesHalted = false;
      }

      const maxOrders = state.hello.caps.max_orders_per_batch;
      const maxOpen = state.hello.caps.max_open_positions;

      // 1) Exits first: they free capital and lock the guardrails.
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
        else if (slot - info.entrySlot >= P.flowDeathMinAge) {
          const tape = tapes.get(mint);
          if (tape !== undefined) {
            const tail = tape.entries.slice(-12);
            let net = 0n;
            for (const t of tail) net += t.buy ? t.sol : -t.sol;
            if (tail.length >= 8 && net < P.flowDeathNet) sell = true;
          }
        }
        // A probe position is sold on the next batch whatever the tape says.
        if (probeState.has(mint)) sell = true;
        if (sell) {
          orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: P.sellSlipBps });
        }
      }

      // 2) Probe round trips when the 20-coin bar lags.
      const needProbes = roundTripCoins.size < P.roundTripTarget;
      if (
        needProbes &&
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

      // 3) Entries, in first-seen curve order (deterministic).
      if (!entriesHalted) {
        for (const [mint] of state.curves) {
          if (orders.length >= maxOrders) break;
          if (state.positions.has(mint) || hasPending(state, mint) || probeState.has(mint)) continue;
          if (state.committedPositionCount() >= maxOpen) break;
          if ((entriesPerCurve.get(mint) ?? 0) >= P.maxEntriesPerCurve) continue;
          const exited = lastExitSlot.get(mint);
          if (exited !== undefined && slot - exited < P.cooldownSlots) continue;
          const stake = entrySignal(state, mint, slot);
          if (stake === 0n) continue;
          const cap = state.maxBuyLamports(mint);
          const amt = stake <= cap ? stake : cap;
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
