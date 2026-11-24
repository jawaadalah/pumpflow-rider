# pumpflow-rider

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/jawaadalah/pumpflow-rider/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/jawaadalah/pumpflow-rider/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A capitulation-reversion paper-trading bot for pump.fun bonding curves. It waits for a proven curve to be dumped hard, buys only once the tape stabilizes and buyers return, and exits fast with mechanical take-profit, stop-loss and trailing stops. Probe round trips keep it above the sprint's 20-coin guardrail, and a drawdown brake halts entries long before the 50% limit. Fully deterministic: slot numbers and the event stream only, no clock, no randomness, no network.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 protocol on stdin/stdout (newline-delimited JSON) and needs Node 22.18 or later, which runs its TypeScript as-is.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9h3tmt5h&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
