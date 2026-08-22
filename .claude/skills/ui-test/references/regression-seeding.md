# Seeding a regression to verify the skill actually catches it

CL-6650's acceptance criteria requires proving the skill flags a known
Tier 1 bug, not just that it produces a report. Use this before trusting
a change to the skill itself.

## Pattern

1. Pick a surface and a specific Tier 1 rule (e.g. "names in name slots").
2. Temporarily edit the source so the surface violates that rule — e.g.
   rename an agent row's displayed name to its description string.
3. Run the ui-test sweep against the running dev server with the edit in
   place. Confirm the report's Tier 1 blockers section names the exact
   row and cites a scoped snapshot line showing the wrong text.
4. Revert the edit (`git checkout -- <file>` or undo the in-memory
   change) before finishing — a seeded regression is a local-only probe,
   never something that ships.

## Worked example (Jimmy's row)

```bash
# Seed: swap the name-slot text for the description text in the
# component that renders the roster row (path depends on the surface
# under test — locate the row-rendering component first).
# e.g. temporarily render {agent.description} where {agent.name} belongs.

agent-browser open http://localhost:3000/<surface>
agent-browser snapshot -i -s "[data-testid=roster]"
# Expect the report to flag: "name slot renders 'Handles onboarding
# flows for new hires' instead of 'Jimmy'" with the scoped snapshot ref
# as evidence.

# Revert the seed once confirmed.
git checkout -- <edited-file>
```

A sweep that reports Tier 2/3 findings but misses the seeded Tier 1 swap
means the Tier 1 walk isn't actually checking name-slot content — fix the
skill's Tier 1 instructions before trusting its verdicts on anything
else.
