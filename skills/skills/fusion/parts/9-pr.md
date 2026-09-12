## Checkpoint 9: Pull Request

When you want to open a pull request:

1. In the PR/branch that we have, run the [TESTING.md](docs/TESTING.md) specification and fix all issues against it.
2. Create a pull request with a clear description of the changes and link to the Linear issue (if this is a non [ad-hoc] PR).
3. Make sure the PR is opened in `Ready for Review` state.
4. Add a `@cursor review` comment to the PR.

### Command

Generate a prompt containing the exact PR title, body, Linear issue link (when applicable), and requested PR actions. Pass it to OpenCode using [spawn.md](docs/skills/fusion/spawn.md#opencode) so Nemotron only performs those actions.
