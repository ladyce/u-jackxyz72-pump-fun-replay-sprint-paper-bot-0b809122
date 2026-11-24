// Selective momentum ladder for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev window actually rewards (measured on the full 24h window with the local
// simulator, tools/sim-all.ts — the pilot baselines and the unfiltered ladder all lose):
//   - SELECTION, not breadth. A coin's launch slot (its CreateEvent slot) predicts its
//     whole life: launches with >=10 distinct non-creator buyers and >=0.5 SOL of creator
//     buying carry momentum; quiet launches mostly die. The filter is the whole edge —
//     unfiltered the same ladder loses -2.9 SOL, filtered to >=10 buyers it wins.
//     The buyer threshold is flat over 8-20 (all +0.08 SOL), so 10 is the middle, not
//     a knife-edge. Tightening the creator-buy leg instead (dev >= 1 or 2 SOL) hurts.
//   - Small, capped size. Buy at the 1%-of-real-reserve cap as real SOL crosses 1/2/5/
//     10/20 (0.01/0.02/0.05/0.10/0.20 SOL), one rung per batch and >=10 slots between
//     buys on the same coin, so a bundled launch that jumps 0 -> 40 real SOL in one
//     slot cannot take the full size at the pumped top price (that single mistake cost
//     -0.16 SOL per coin in the early ladder). Faster adds (5 slots) are much worse.
//   - Bank before the cliff. Winners rise then dump 80%+ within 1-2 slots, and a
//     reactive exit always fills after the dump (2-slot latency), so profits must be
//     banked while the price is still up: sell half at 1.5x cost, half of the rest at
//     2.5x, and exit the whole position at 1.25x cost. A 5% trailing stop from peak
//     (also the stop loss, since the peak starts at cost) cuts losers fast, plus an
//     exit on a single recorded sell of 3+ SOL. Letting winners ride on a loose trail
//     was tested and REJECTED: cliffs eat armed positions.
//   - Honest caveat: the dev-window win is concentrated — one coin (52frC8om) is
//     +0.134 of the +0.077 total, the other 8 winners sum to +0.031 and 47 coins lose
//     ~-0.002 each. The bot is a lottery ticket on the final window having its own
//     big runner; without one it loses ~-0.05. The first half of the dev window is
//     negative in every config (-0.057), the second half carries the win (+0.134).
//
// Everything is a pure function of the batches the harness sends: no clock, no
// environment, no randomness, so the two graded executions produce byte-identical
// action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface LadderRung {
  /** Real SOL (lamports) the curve must hold for this rung. */
  realLamports: number;
  /** Total lamports committed to the position once this rung is filled. */
  totalLamports: number;
}

export interface Params {
  /** The ladder: real-SOL thresholds and the total size at each. */
  ladder: LadderRung[];
  /** Slots to wait between two buys on the same coin. */
  addDelay: number;
  /** Trailing stop: exit when liquidation value falls this far below its peak (fraction). */
  trail: number;
  /** Once the position's peak value reaches this far over cost, the trailing stop
      switches to trailArmed. Set tighter than trail (the default): a position that
      has already run 10% has profit worth locking in, so its stop tightens to 3%.
      A looser armed trail was tested and REJECTED — cliffs eat ridden positions. */
  trailArm: number;
  trailArmed: number;
  /** Bank the whole position when its liquidation value reaches this multiple of
      cost (0 = disabled). A modest fixed take-profit banks smooth runners before
      the cliff, while the tight trail still cuts losers. */
  tpAll: number;
  /** Sell this share of the position when value first reaches tp1x cost (fraction). */
  tp1x: number;
  tp1Part: number;
  /** Sell this share of the remainder when value first reaches tp2x cost. */
  tp2x: number;
  tp2Part: number;
  /** Exit everything on a single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Slippage allowed on buys (bps); sells always 10000. */
  buySlipBps: number;
  /** Exit after this many slots held, whatever the value. */
  maxHold: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Skip a coin whose creator sold before entry. */
  skipDevSold: boolean;
  /** Launch filter: enter only coins whose launch slot (the CreateEvent slot) had at
      least this many distinct non-creator buyers and at least this much creator buying
      (SOL). Launches with many buyers and a big creator buy carry the momentum; quiet
      launches mostly die. Set minLaunchBuyers 0 to disable. */
  minLaunchBuyers: number;
  minLaunchDevBuySol: number;
  /** Smallest buy worth sending (lamports). */
  minBuyLamports: number;
  /** Most momentum positions open at once. */
  maxMain: number;
  /**
   * Guardrail pacing: the run must end with a round trip of at least 0.01 SOL on each of
   * at least 20 coins. When distinct coins traded or fills lag the pace (scaled by block
   * time over paceSecs), open tiny probe round trips (buy probeSol, sell as soon as it
   * lands). Normally the ladder trades hundreds of coins and probes never fire.
   */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

const SOL = 1_000_000_000;

// Locked by the local simulator on the full dev window (see header): filter >=10 launch
// buyers, trail 5%, bank-all at 1.25x, partials at 1.5x/2.5x. Sim net +0.077 SOL
// (halves -0.057/+0.134, 290 fills, 56 mints, maxDD 0.0084). The ladder sizes are the
// 1%-of-real-reserve buy caps at each threshold, not tuned values.
export const DEFAULT_PARAMS: Params = {
  ladder: [
    { realLamports: 1 * SOL, totalLamports: 0.01 * SOL },
    { realLamports: 2 * SOL, totalLamports: 0.02 * SOL },
    { realLamports: 5 * SOL, totalLamports: 0.05 * SOL },
    { realLamports: 10 * SOL, totalLamports: 0.1 * SOL },
    { realLamports: 20 * SOL, totalLamports: 0.2 * SOL },
  ],
  addDelay: 10,
  trail: 0.05,
  trailArm: 0.1,
  trailArmed: 0.03,
  tpAll: 1.25,
  tp1x: 1.5,
  tp1Part: 0.5,
  tp2x: 2.5,
  tp2Part: 0.5,
  bigSellSol: 3,
  buySlipBps: 10_000,
  maxHold: 4000,
  staleSlots: 600,
  skipDevSold: false,
  minLaunchBuyers: 10,
  minLaunchDevBuySol: 0.5,
  minBuyLamports: 0.005 * SOL,
  maxMain: 5,
  targetCoins: 30,
  targetFills: 240,
  paceSecs: 14400,
  probeSol: 0.01,
  maxProbes: 2,
};

const LAMPORTS = 1e9;
/** Curve fees on a sale: protocol 95 bps + creator 30 bps. */
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Coin {
  mint: Pubkey;
  created: number | null;
  creator: Pubkey | null;
  devSold: boolean;
  lastTradeSlot: number;
  /** Index of the next ladder rung not yet bought. */
  nextRung: number;
  /** Lamports actually filled on buys for this coin (rejected buys count for nothing). */
  spent: number;
  /** Slot of the last buy decided on this coin. */
  lastBuySlot: number;
  /** The coin is finished for us (exited, completed, or missed and past entry). */
  done: boolean;
  entries: number;
  /** Launch-slot signature: the slot the coin was created in (or first seen). */
  launchSlot: number | null;
  /** Distinct non-creator buyers in the launch slot. */
  launchBuyers: Set<Pubkey>;
  /** SOL the creator bought in the launch slot. */
  launchDevBuy: number;
}

interface Held {
  opened: number;
  peakValue: number;
  lastValue: number;
  exiting: boolean;
  filled: boolean;
  /** Take-profit stage: 0 = none taken, 1 = tp1 taken, 2 = tp2 taken. */
  tpStage: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { mint, created: null, creator: null, devSold: false, lastTradeSlot: -1e12, nextRung: 0, spent: 0, lastBuySlot: -1e12, done: false, entries: 0, launchSlot: null, launchBuyers: new Set(), launchDevBuy: 0 };
      coins.set(mint, c);
    }
    return c;
  };

  /** Highest ladder rung whose real-SOL threshold the curve has reached. */
  const rungReached = (realLamports: number): number => {
    let r = -1;
    for (let i = 0; i < p.ladder.length; i++) {
      if (realLamports >= p.ladder[i]!.realLamports) r = i;
    }
    return r;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      const bigSell = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
          if (f.side === 'buy') coinOf(f.mint).spent += Number(f.quote_lamports);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
          c.lastTradeSlot = e.slot;
          c.launchSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          c.lastTradeSlot = e.slot;
          if (c.launchSlot === null) c.launchSlot = e.slot;
          if (e.slot === c.launchSlot && e.is_buy) {
            if (c.creator !== null && e.user === c.creator) c.launchDevBuy += Number(e.sol_amount) / LAMPORTS;
            else if (c.creator !== null) c.launchBuyers.add(e.user);
          }
          if (!e.is_buy && c.creator !== null && e.user === c.creator) c.devSold = true;
          if (!e.is_buy && Number(e.sol_amount) / LAMPORTS >= p.bigSellSol) bigSell.add(e.mint);
          traded.add(e.mint);
        } else {
          const c = coinOf(e.mint);
          c.done = true;
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: take-profits, trailing stop, big-sell exit, max hold, stale.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coinOf(mint);
            if (h.filled) c.done = true;
            else c.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (h.peakValue <= 0) h.peakValue = cost;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        if (h.exiting) {
          if (pendingByMint.has(mint)) continue;
          if (orders.length >= cap) break;
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
          continue;
        }
        // Partial take-profits: bank half at 2x cost, half of the rest at 3x.
        let tpPart = 0;
        if (h.tpStage === 0 && cost > 0 && value >= cost * p.tp1x) tpPart = p.tp1Part;
        else if (h.tpStage === 1 && cost > 0 && value >= cost * p.tp2x) tpPart = p.tp2Part;
        if (tpPart > 0) {
          if (pendingByMint.has(mint)) continue;
          const part = BigInt(Math.floor(tokens * tpPart));
          if (part > 0n && part < pos.token_amount) {
            if (orders.length >= cap) break;
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
            // The sale halves the position: rebase the peak to the post-sale value so
            // the trailing stop does not fire on the sale itself.
            h.peakValue = value * (1 - tpPart);
            h.tpStage++;
            continue;
          }
        }
        let exit = false;
        // Tightening trail: 5% while the position has not yet run, 3% once its peak
        // is trailArm over cost, so a runner's profit is locked in rather than
        // ridden into the cliff.
        const effTrail = h.peakValue >= cost * (1 + p.trailArm) ? p.trailArmed : p.trail;
        if (value < h.peakValue * (1 - effTrail)) exit = true;
        if (p.tpAll > 0 && value >= cost * p.tpAll) exit = true;
        if (bigSell.has(mint)) exit = true;
        if (now - h.opened > p.maxHold) exit = true;
        if (now - coinOf(mint).lastTradeSlot >= p.staleSlots) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries and ladder adds, in the order coins traded this batch. At most one buy
      // per coin per batch, and at least addDelay slots between buys on the same coin.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const c = coinOf(mint);
        if (c.done) continue;
        const h = held.get(mint);
        const realLamports = Number(curve.real_quote_reserves);
        const reached = rungReached(realLamports);
        if (reached < 0) continue;
        if (h === undefined) {
          // First entry: the first rung only, even if the curve already jumped past
          // higher rungs in one slot — the later rungs are bought one batch at a time.
          if (slotsLeft <= 0) continue;
          if (p.skipDevSold && c.devSold) {
            c.done = true;
            continue;
          }
          // Launch filter: only launches with a crowd and a committed creator.
          if (c.launchBuyers.size < p.minLaunchBuyers || c.launchDevBuy < p.minLaunchDevBuySol) {
            c.done = true;
            continue;
          }
          const wantLamports = p.ladder[0]!.totalLamports;
          const capLamports = Number(state.maxBuyLamports(mint));
          let amount = Math.min(wantLamports, capLamports);
          if (amount > free * LAMPORTS - Number(state.txFeeLamports())) {
            amount = free * LAMPORTS - Number(state.txFeeLamports());
          }
          if (amount < p.minBuyLamports) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount)), max_slippage_bps: p.buySlipBps });
          free -= amount / LAMPORTS + tx;
          c.nextRung = 1;
          c.lastBuySlot = now;
          c.entries++;
          held.set(mint, { opened: now, peakValue: 0, lastValue: 0, exiting: false, filled: false, tpStage: 0 });
          slotsLeft--;
        } else {
          // Ladder add: one rung at a time, spaced by addDelay slots.
          if (h.exiting || !h.filled) continue;
          if (now - c.lastBuySlot < p.addDelay) continue;
          if (c.nextRung >= p.ladder.length || c.nextRung > reached) continue;
          const wantLamports = p.ladder[c.nextRung]!.totalLamports - c.spent;
          if (wantLamports <= 0) {
            c.nextRung++;
            continue;
          }
          const capLamports = Number(state.maxBuyLamports(mint));
          let amount = Math.min(wantLamports, capLamports);
          if (amount > free * LAMPORTS - Number(state.txFeeLamports())) {
            amount = free * LAMPORTS - Number(state.txFeeLamports());
          }
          if (amount < p.minBuyLamports) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount)), max_slippage_bps: p.buySlipBps });
          free -= amount / LAMPORTS + tx;
          c.nextRung++;
          c.lastBuySlot = now;
        }
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * BPS_PER_UNIT) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
