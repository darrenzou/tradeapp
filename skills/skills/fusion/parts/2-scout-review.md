## Checkpoint 2: Context Review (optional)

Look at the context gathered by the scouring agent. See if there are any gaps that need to be filled here. Are there parts of the system that are unclear or seem like something is missing? This determination should be made based on the task that we are trying to accomplish, the agent's response, and your light orientation and the information you already have. Do not be speculative here, but do not go exploring the codebase yourself either.

Ask the explore agent for a targeted scan to fill the gaps. This step only needs to be done if there is incomplete or missing information.

This is also where you should evaluate if you need information from outside sources. You can refer to [VENDORS.md](docs/VENDORS.md) for details on third-party dependencies and external integrations. And you can have this agent search the internet for external references if needed to strengthen your understanding.

Be judicious about when to invoke this agent. Not every case requires additional context.

Completion criterion: the follow-up would let planning proceed without speculative architecture.
