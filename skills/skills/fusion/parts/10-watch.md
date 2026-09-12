# Checkpoint 10 (on-demand): PR Watcher

This checkpoint monitors the status of an open pull request. Some things to watch out for:

- Review comments from review bots like cursor[bot] and greptile-apps[bot]

## Procedure

Run the following loop exactly twice:

1. Run `gh pr checks --watch --interval 10` as a background process and wait for its completion notification to wake you. Do not use `--fail-fast`; the checks are only a wake signal for completed bot reviews.
2. Inspect unresolved review threads authored by cursor[bot] and greptile-apps[bot]. Ignore all other comments and CI results, including failures.
3. Judge each comment rather than accepting it automatically:
   - If it is incorrect or not worth addressing, reply with a concise reason for rejecting it.
   - If it is legitimate, use [Checkpoint 8](docs/skills/fusion/parts/8-fix.md) to fix it. After the fix is pushed, reply with what was addressed.
4. Resolve each GitHub review thread after replying and, when applicable, pushing its fix.
5. After the first pass only, add two separate PR comments to trigger fresh bot reviews: `@cursor review` and `@greptileai`.
6. Start the second pass against the latest commit.

Reviewer bots run as PR checks, so check completion is only the wake signal. Other CI issues are outside this loop. Do not create a custom polling script.

Before closing this checkpoint out, look at the state of CI, if anything is failing, determine the target fix for it and then dispatch Nemotron using [spawn.md](docs/skills/fusion/spawn.md#opencode) to fix those issues.

This checkpoint can only be closed when CI is fully green. If the same CI task fails after a fix attempt, ask the human for guidance instead of trying random approaches.
