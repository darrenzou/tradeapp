# Phone alerts (ntfy)

Darren gets no phone notification when a project thread finishes, so threads send their own through ntfy.

When a thread finishes its work or needs Darren (a decision, a blocker, a PR ready for review), send one alert. Not for routine progress.

```bash
curl -s -H "Title: <thread title>" \
  -H "Click: https://claude.ai/code/project/chan_01GgU6Tbz6QwxRuFkr6x249W?thread=<this thread's cmsg id>" \
  -d "<one line: what is done or what is needed>" \
  "https://ntfy.sh/$NTFY_TOPIC"
```

- `NTFY_TOPIC` is a cloud environment variable and works like a password. Never print it or write it anywhere.
- No dollar amounts, balances or account details: ntfy's server can read alerts.
- On HTTP 429 (ntfy's per-address limit; the cloud address is shared), retry once after a few seconds.
- If `NTFY_TOPIC` is empty or ntfy.sh is unreachable, skip the alert without mentioning it.
