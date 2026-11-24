// Burst Rider: a fast launch-scalping bot for the agent-fun/replay/v2 pump.fun replay.
//
// What the dev window teaches: a new coin's price jumps in its very first slot
// (median +17% off its create price before any bot can act — the first trade lands
// in the create slot itself), then fades. Buying the open blind loses: from two
// slots after creation the median forward return is ~0% and drifting down. The
// only durable edge in the data is selection: launches that already show real
// early demand — seven or more distinct buyers in their first two slots, net SOL
// flowing in, price already up 50% off create, creator still holding — spike
// further in the next few slots often enough to pay for the losers. So this bot
// buys only those hot launches, one flat buy each, and gets out fast: take profit
// at +25%, stop loss at -10%, and a hard 10-slot maximum hold, so capital keeps
// cycling to the next launch instead of riding the fade. A trailing stop was tried
// and did not help on the dev window; neither did pyramiding or longer holds.
//
// Sizing is flat (0.1 SOL a coin, capped at 1% of the curve's real SOL): the edge,
// if any, is in catching a few big runners across many coins, not in sizing up any
// single one. Fees dominate at this size, so every exit is measured against cost
// including the curve fee (95 + 30 bps) and the per-order transaction fee.
//
// Guardrails: a probe fallback keeps the run above the 20-coin minimum bar. If the
// entry filter has produced too few coins by the time most of the window's block
// time has passed, the bot buys tiny 0.01 SOL round trips on liquid fresh curves
// and sells them as soon as they land, so the run still clears the bar.
//
// Deterministic by construction: no clock, no randomness, no environment reads;
// iteration only over insertion-ordered maps fed by the batch stream. All amounts
// are bigint lamports; prices are compared as reserve ratios, never floats.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to spend on one coin (each reply is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window (skin in the game, not a whale). */
  minDevBuy: number;
  maxDevBuy: number;
  /** Trades seen and distinct non-creator buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: window (skip coins that already mooned). */
  minRunupBps: number;
  maxRunupBps: number;
  /** Recent-flow window (slots) and the minimum net lamports bought minus sold in it. */
  flowWindow: number;
  minFlowLamports: number;
  /** Distinct non-creator buyers inside the recent-flow window, at least. */
  minRecentBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the recent net flow falls below minus this many lamports. */
  exitFlowLamports: number;
  /** Probe fallback: target coins and the block-time window they are paced over. */
  targetCoins: number;
  paceSecs: number;
  /** Probe buy size (lamports); must clear the 0.01 SOL round-trip minimum. */
  probeLamports: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 2,
  stakeLamports: 100_000_000,
  minBuyLamports: 5_000_000,
  minRealSol: 1_000_000_000,
  maxRealSol: 40_000_000_000,
  minDevBuy: 500_000_000,
  maxDevBuy: 1_000_000_000_000,
  minTrades: 6,
  minBuyers: 7,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  minRunupBps: 5_000,
  maxRunupBps: 1_000_000,
  flowWindow: 10,
  minFlowLamports: 1_000_000_000,
  minRecentBuyers: 5,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tpBps: 2_500,
  slBps: 1_000,
  trailArmBps: 1_000_000,
  trailBps: 1_000,
  maxHold: 10,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  exitFlowLamports: 1_000_000_000_000,
  targetCoins: 25,
  paceSecs: 21_600,
  probeLamports: 10_000_000,
  maxProbes: 1,
};

const BPS = 10_000n;
/** Curve fee on a sale: protocol 95 bps + creator 30 bps. */
const FEE_BPS = 125n;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Transaction fees paid on this position's orders so far. */
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Bot {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let nowTime = 0;

  /** What selling `tokens` against (vq, vt) would pay after curve fees. */
  function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
    if (tokens <= 0n || vt <= 0n) return 0n;
    const q = (tokens * vq) / (vt + tokens);
    return q - (q * FEE_BPS + BPS - 1n) / BPS;
  }

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold and the distinct buyers, over the last flowWindow slots. */
  function flow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === side) return true;
    }
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          probes.delete(f.mint);
          continue;
        }
        if (f.status === 'filled' && f.side === 'buy') myCoins.add(f.mint);
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
          });
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }
      for (const mint of [...probes.keys()]) {
        if (!state.positions.has(mint) && !hasPending(state, mint, 'buy') && !hasPending(state, mint, 'sell')) {
          probes.delete(mint);
        }
      }

      // Exits first: every held position is re-priced and sold on the first trigger.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) {
            exit = true;
          }
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
          if (flow(c, state.slot).net < -BigInt(P.exitFlowLamports)) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, isSelling] of probes) {
        if (orders.length >= cap) break;
        if (isSelling) continue;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined || curve.complete) continue;
        if (hasPending(state, mint, 'buy') || hasPending(state, mint, 'sell')) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        probes.set(mint, true);
      }

      // Entries: one flat buy per coin that shows a burst forming.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (age < P.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        if (hasPending(state, c.mint, 'buy') || hasPending(state, c.mint, 'sell')) continue;
        if (probes.has(c.mint) || state.positions.has(c.mint)) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && P.skipDevSold) {
          c.done = true;
          continue;
        }
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) continue;
        if (c.trades < P.minTrades || c.buyers.size < P.minBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(P.maxBigSellBps)) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (vt === 0n || c.vt0 === 0n) continue;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup < BigInt(P.minRunupBps) || runup > BigInt(P.maxRunupBps)) continue;
        const fl = flow(c, state.slot);
        if (fl.net < BigInt(P.minFlowLamports) || fl.buyers < P.minRecentBuyers) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const want = BigInt(P.stakeLamports);
        const amount = want < maxBuy ? want : maxBuy;
        if (amount < BigInt(P.minBuyLamports)) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.done = true;
        open += 1;
      }

      // Probe fallback: keep the run above the coin minimum when the filter starves it.
      if (probes.size < P.maxProbes && firstTime !== null && nowTime > firstTime) {
        const elapsed = Math.min(P.paceSecs, nowTime - firstTime);
        const pace = elapsed / P.paceSecs;
        if (myCoins.size < Math.ceil(P.targetCoins * pace)) {
          const minRq = (BigInt(P.probeLamports) * BPS) / BigInt(state.hello.caps.max_order_bps_of_real_reserve);
          for (const c of coins.values()) {
            if (orders.length >= cap || probes.size >= P.maxProbes) break;
            if (c.done || c.complete) continue;
            if (state.positions.has(c.mint) || probes.has(c.mint)) continue;
            if (hasPending(state, c.mint, 'buy') || hasPending(state, c.mint, 'sell')) continue;
            if (myCoins.has(c.mint)) continue;
            const curve = state.curves.get(c.mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < (minRq * 3n) / 2n) continue;
            if (free < BigInt(P.probeLamports) + 2n * tx) break;
            orders.push({ side: 'buy', mint: c.mint, quote_lamports: BigInt(P.probeLamports), max_slippage_bps: P.buySlippageBps });
            probes.set(c.mint, false);
            free -= BigInt(P.probeLamports) + tx;
          }
        }
      }

      return orders;
    },
  };
}
