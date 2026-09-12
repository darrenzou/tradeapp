## Checkpoint 4: Approach discussion

This checkpoint is a loop where you will do a back and forth with the user until the user is satisfied with the direction that we are taking with this task.

The plan you come up with here should be a directional brief, this plan should not contain the full implementation details. This is more of a design document where we go over things like:

- Data model (Only necessary when we are making meaningful changes to the data model)
  - Give a high-level overview of the data model first, what exists today.
  - What changes we are making to the data model with this plan.
  - What tradeoffs are we considering here in terms of structure our data model like this.
  - Any concerns about query performace/indexing.
  - Balance between data model complexity, adding more columns vs. consolidation and storing data in JSON blobs.
  - What data fields are being added/removed/update.
- Give an overview of the abstractions we are going to use in this plan.

- proposed approach
- likely changed areas
- important tradeoffs
- open decisions
- verification shape

Do not include a full implementation checklist yet.

At the end of each iteration ask for confirmation on the draft approach. Move to the next checkpoint when the human is satisfied with the plan.

When you are iterating with the human on this plan, refer to these guidelines:

- [unslop](docs/skills/unslop.md)
- [technical-writing](docs/skills/technical-writing.md)

These guidelines help you maintain coherency when going back and forth with the human.

Completion criterion: the human can quickly accept, reject, or redirect the approach.
