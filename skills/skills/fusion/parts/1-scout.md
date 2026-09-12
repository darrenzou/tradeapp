## Checkpoint 1: Context Scouring

Explore the codebase to answer the question "What is the current state of the codebase for this proposed feature?". Produce clear architectural explanations at the level of a senior engineer onboarding onto a subsystem. We are trying to build a mental model of the existing system here, not pedantically annotating source code.

### Step 1: Understand the question and its associated complexity

Understand the change being proposed, what is the nature of it:

- Is the change a new feature/flow?
- Is it a refactor of existing functionality/architecture?
- Is it scoped to a specific subsystem in our codebase?
- Is it a bug investigation, performance optimization, or a security fix that requires o11y exploration?

Identify the scope of the change. If ambiguous, state your best guess interpretation before exploring. Don't ask the user for confirmation. The user will redirect you if you are off.

Identify the associated complexity of the change:

- **Simple** (scoped to a single module, small utility, bug fix, etc.): Spin up a single explorer agent to collect any relevant context in a single pass.
- **Complex** (a subsystem spanning multiple files/services, cross-cutting feature, architectural refactor, etc.): Spin up parallel explorer agents. For complex changes, use this exploration playbook:

  First, decompose the requested change into 2-4 parallel exploration angles, we want to capture the different surfaces of the change and how it interacts with our current system. For narrow complex changes, 2 angles may be sufficient; for broad subsystem spanning changes, use up to 4.

  For instance, the split for a change to the temporal subsystem would look like:

  - Explorer 1: Data model and schema definitions
  - Explorer 2: Core services, interfaces, and business logic, and system behavior
  - Explorer 3: Integration points, external dependencies, and API contracts

### Step 2: Explore the codebase

Any agent spun up for context gathering should be readonly. Use the [explorer-prompt.md](docs/skills/fusion/references/explorer-prompt.md) as the base prompt for the agents you spin up here plus an exploration angle naming its slice.

Use [spawn.md](docs/skills/fusion/spawn.md#cursor) with model `cursor-grok-4.6-high` to spin up any explorer agents.

Each explorer should:

- Start broad: Glob for relevant directories, Grep for key types/interfaces/class names
- Follow the thread: from an entry point, trace the call chain (callers, callees, data flow, type definitions)
- Read the actual code, don't guess from file names
- Stop when it can describe the full path from input to output (or trigger to effect) without hand-waving any step
- Note things that are surprising, non-obvious, or that a newcomer would get wrong

Each explorer returns structured findings: components found, flow traced, files read, anything non-obvious. Overlap between explorers is fine; you can reconcile.
