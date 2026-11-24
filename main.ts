// Pump.fun Replay Sprint — Paper Bot, Real Ranking.
// Selective momentum ladder: only launches with >=10 distinct non-creator buyers and
// >=0.5 SOL of creator buying in the launch slot are entered, in small size as real
// SOL crosses 1/2/5/10/20 (0.01/0.02/0.05/0.10/0.20 SOL); bank half at 1.5x cost,
// half of the rest at 2.5x, exit all at 1.25x, 5% trailing stop (3% once up 10%).
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts, the
// protocol in the vendored SDK shim (vendor/makefun-bot.ts, a copy of the kit's
// sdk/ts/makefun-bot.ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
