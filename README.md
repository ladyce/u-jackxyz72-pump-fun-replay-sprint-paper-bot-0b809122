# Pump.fun Replay Sprint — Paper Bot, Real Ranking

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/ladyce/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/ladyce/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for [make.fun's Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) competition: it trades 10 SOL of paper money over a 24-hour replay of recorded pump.fun activity. Paper trading only — no real money anywhere.

## Strategy

Selective momentum ladder. Only launches whose launch slot (their `CreateEvent` slot) had **at least 10 distinct non-creator buyers** and **at least 0.5 SOL of creator buying** are entered — that launch signature is the whole edge (unfiltered, the same ladder loses 2.9 SOL on the dev window; filtered to ≥10 buyers it wins). The buyer threshold is flat over 8–20, so 10 is the middle of a plateau, not a knife-edge.

- **Size:** buy at the 1%-of-real-reserve cap as real SOL crosses 1/2/5/10/20 (0.01/0.02/0.05/0.10/0.20 SOL), one rung per batch and ≥10 slots between buys on the same coin, so a bundled launch that jumps 0 → 40 real SOL in one slot cannot take the full size at the pumped top price.
- **Bank before the cliff:** winners rise then dump 80%+ within 1–2 slots, and a reactive exit always fills after the dump (2-slot latency), so profits are banked while the price is still up — sell half at 1.5x cost, half of the rest at 2.5x, exit the whole position at 1.25x cost. A 5% trailing stop (3% once the position is up 10%) cuts losers fast, plus an exit on a single recorded sell of 3+ SOL.
- **Honest caveat:** the dev-window win is concentrated — one coin (`52frC8om`) is +0.134 of the +0.077 SOL total. The bot is a lottery ticket on the final window having its own big runner; without one it loses ~−0.05 SOL.

## Run

```sh
node main.ts
```

`main.ts` is the entrypoint; the strategy lives in `strategy.ts`, and the protocol in the vendored SDK shim `vendor/makefun-bot.ts` (a copy of the kit's `sdk/ts/makefun-bot.ts`).

## Dev-window results (local simulator + house `grade-local`)

| Metric | Value |
| --- | --- |
| Net PnL | **+0.077 SOL** |
| Halves (first / second) | −0.057 / +0.134 SOL |
| Fills / distinct mints | 289 / 56 |
| Max drawdown | 0.0084 |
| Round trips counted | 132 (56 mints) |
| House grade | compliant, deterministic (two runs reproduced) |
| Stress (rebuilt windows, interim) | 4 of 10 copies done, all negative: −0.05, −0.07, −0.09, −0.06 SOL — the dev win depends on this window's own coins |

## License

MIT
