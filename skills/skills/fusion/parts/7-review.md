## Checkpoint 7: Review Changes

Gather context from the previous checkpoints. Run review tasks via [spawn.md](docs/skills/fusion/loop/spawn.md#claude). Use Opus 5 xhigh for this. During this checkpoint the Claude agent should stay in read-only mode.

Do not read the files we are sending for review yourself, send references to these files to the Opus review sub agent and have it read the files.

Fan out parallel Claude agents for each of these:

- Validate all testing code against [principle-writing-good-tests](docs/skills/code/principle-writing-good-tests.md).
- Validate against [CODING_STANDARDS](docs/CODING_STANDARDS.md).
- Validate new documentation introduced against [technical-writing](docs/skills/technical-writing.md).
- Validate all non-test TypeScript code against [principle-typescript-best-practices](docs/skills/code/principle-typescript-best-practices.md).

Spin up an Opus 5 sub-agent with the prompt `/code-review high` for the diffs on this branch/PR.

Do not modify the codebase at this checkpoint. Only review and validate.

Some caveats:

- Flag any unnecessary or unfocused review feedback. Opus has tendencies to get defiant and distracted, keep it in check and on task.
- Beware of overly nitpicky or pedantic feedback. We want to focus on issues that might break what we are trying to implement, things like hidden bugs, inconsistencies, and edge cases should not be ignored.
- For any findings that change product behavior or are unexpected, or findings where the repurcussions are not super clear, a human should be consulted. In that case, stop and ask for a human's approval for that finding before dispatching the review fixer.
- Run these Opus reviewer's judiciously in the sense that:
  - if we didn't make TypeScript changes, don't run the TypeScript review.
  - If we didn't make any documentation changes, don't run the technical writing review.
  - If we didn't make any test changes, don't run the testing review.
  - If we didn't make any substantial code changes, don't run the coding standards review or the `/code-review high` sub-agent.
- One review pass is sufficient unless significant new issues are discovered that require additional iterations. For additional review iterations you need to explicitly request them from the human.
