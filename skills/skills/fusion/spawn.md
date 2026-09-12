# Agent Spawn CLI

When spawning these agents, make sure you use the CLI commands here, do not use the tools you have available to you to spawn these specific agents. You are free to use your built in tools for other purposes; however, these agents need to be invoked via the CLI commands listed here.

## Cursor

Binary: `agent`

Fixed model: `cursor-grok-4.6-high`

Use as a deep scout and explorer for the codebase.

```bash
agent -p \
  --trust \
  --force \
  --workspace "$PWD" \
  --model <model> \
  --output-format json \
  "<prompt>" </dev/null | jq -r '.result'
```

## Codex

Binary: `codex`

Allowed configs (only these):

| Model                       | Effort          |
| --------------------------- | --------------- |
| `5.6 Sol` (`gpt-5.6-sol`)   | `xhigh`, `high` |
| `5.6 Luna` (`gpt-5.6-luna`) | `max`           |

Use with reasoning `xhigh` when implementing changes the first time. Use `high` for subsequent iterations such as bug fixes, optimizations, and code review fixes. Reach for luna for quick changes.

```bash
OUT="$(mktemp "${TMPDIR:-/tmp}/codex-result.XXXXXX")"
codex exec \
  --cd "$PWD" \
  -m <model> \
  -c model_reasoning_effort='"<effort>"' \
  -c service_tier='"default"' \
  --sandbox workspace-write \
  --output-last-message "$OUT" \
  "<prompt>" </dev/null >/tmp/codex-progress.log 2>&1
STATUS=$?
cat "$OUT" 2>/dev/null || true
exit $STATUS
```

## Claude

Binary: `claude`

Allowed configs (only these; no fast mode):

Use Fable rarely. In most cases you don't need Fable, it should be reserved for the most complex tasks requiring deep reasoning and complex problem solving.

Fable should never be used outside of readonly mode. Whenever you invoke Fable, ensure you include this in your prompt:

> "You are in read-only mode. Do not modify any files."

Use Opus 5 xhigh for code review tasks. Opus is allowed to be non-readonly.

| Model                      | Effort  |
| -------------------------- | ------- |
| `fable` (`claude-fable-5`) | `high`  |
| `opus` (`claude-opus-5`)   | `xhigh` |

```bash
claude -p \
  --model <model> \
  --effort <effort> \
  --dangerously-skip-permissions \
  --output-format json \
  "<prompt>" </dev/null | jq -r '.result'
```

## OpenCode

Binary: `opencode`

Allowed configs (only these):

| Model                                                              | Variant |
| ------------------------------------------------------------------ | ------- |
| `Nemotron 3.5 Lightning Free` (`opencode/nemotron-3.5-lightning-free`) | `max`   |
| `Nemotron 3 Ultra Free` (`opencode/nemotron-3-ultra-free`)             | `max`   |

```bash
opencode run \
  --dir "$PWD" \
  --auto \
  --format json \
  -m <model> \
  --variant <variant> \
  "<prompt>" </dev/null \
  | jq -rs '[.[] | select(.type=="text") | .part.text] | join("")'
```
