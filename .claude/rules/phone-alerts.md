# Phone alerts (ntfy)

Darren gets no phone notification when a project thread finishes, so threads send their own through ntfy.

When a thread finishes its work or needs Darren (a decision, a blocker, a PR ready for review), send one alert. Not for routine progress.

Skip the alert when Darren is likely already looking:
- he wrote in this thread in the last 5 minutes, or
- his phone reports the Claude app open. An iPhone Shortcuts automation sends `open` or `closed` to a second topic whenever he opens or leaves Claude:

```bash
curl -s "https://ntfy.sh/$NTFY_STATUS_TOPIC/json?poll=1&since=2h" | tail -1 | grep -q '"message":"open"' && echo open
```

An `open` older than 2 hours is ignored, so a missed `closed` can't silence alerts for long. If `NTFY_STATUS_TOPIC` is empty, rely on the 5-minute rule alone.

To send:

```bash
curl -s -H "Title: <thread title>" \
  -H "Click: https://claude.ai/code/project/chan_01GgU6Tbz6QwxRuFkr6x249W?thread=<this thread's cmsg id>" \
  -d "<one line: what is done or what is needed>" \
  "https://ntfy.sh/$NTFY_TOPIC"
```

- `NTFY_TOPIC` and `NTFY_STATUS_TOPIC` are cloud environment variables and work like passwords. Never print them or write them anywhere.
- No dollar amounts, balances or account details: ntfy's server can read alerts.
- On HTTP 429 (ntfy's per-address limit; the cloud address is shared), retry once after a few seconds.
- If `NTFY_TOPIC` is empty or ntfy.sh is unreachable, skip the alert without mentioning it.
