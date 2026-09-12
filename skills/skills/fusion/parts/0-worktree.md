### Checkpoint 0 (optional): Worktree

Determine if a worktree is needed for this task. Here's how you should decide if a worktree is needed or not:

- The default for starting any new task should be a new worktree. You can create a branch name using the `docs/CONTRIBUTING.md` file. You can create a new worktree using this command:

```bash
WORKTREE_NAME=$(openssl rand -hex 2)
git worktree add ~/.codex/worktrees/$WORKTREE_NAME/emporos -b <branch> origin/main
```

To set the worktree up for development, run this command:

```bash
cd ~/.codex/worktrees/$WORKTREE_NAME/emporos && pnpm setup:worktree
```

- If the task is minor (e.g., a single file fix, config change, or documentation update), skip the worktree entirely and work directly in the main branch.
- If the user explicitly requests to work directly on the main branch, skip the worktree entirely and work directly in the main branch.
