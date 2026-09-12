## Checkpoint 6: Implementing the plan with agent

Use this shape to prompt the implementation agent:

```text
Stay scoped to this task. Inspect named files and nearby call sites before editing. Preserve existing style and conventions. Avoid unrelated refactors. Do not revert unrelated user changes.

Goal:
<goal>

Verified context:
<facts from Grok packet>

Non-goals:
<what not to change>

Likely files/areas:
<files and why>

Data model and interfaces:
<boundaries, interfaces, and types>

Implementation steps:
1. <step>
2. <step>
3. <step>

Invariants and edge cases:
- <invariant>

Verification:
- <commands/tests>

Final response format:
- Changed files
- Behavior summary
- Tests/commands run with results
- Anything incomplete and why
```

Hand the generated plan to the implementor via [spawn.md](docs/skills/fusion/loop/spawn.md#codex) with the model Sol and reasoning `xhigh`.

Completion criterion: implementation agent can implement without rediscovering architecture, while still checking exact code before edits.
