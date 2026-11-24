# Burst Rider — Pump.fun Paper Sprint

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Erwinsays12/makefun-pump-sprint/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Erwinsays12/makefun-pump-sprint/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A fast launch-scalping bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) competition on make.fun. Paper trading only — the replay uses market data, never real funds.

## Idea

On pump.fun almost every new coin dumps within a minute, but a small share bursts
2–10x in its first seconds while fresh buyers pile in. Burst Rider only buys
launches that already show that burst forming — several distinct buyers, net SOL
flowing in, price climbing off its create price, creator still holding — and then
gets out fast: a tight stop loss, a trailing stop once the position is up, a hard
take-profit for moonshots, and a short maximum hold so capital keeps cycling to
the next launch instead of bleeding out on a slow rug.

Sizing is small and flat (one buy per coin, no adds): the edge, if any, is in
catching a few big runners across many coins, not in sizing up any single one.

## Layout

- `main.ts` — entrypoint: hands the strategy to the replay shim.
- `strategy.ts` — the whole strategy (original code, written for this entry).
- `vendor/makefun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts` shim, vendored byte for byte.

## Run

Grade locally with the competition kit (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

## License

MIT — see `LICENSE`.
