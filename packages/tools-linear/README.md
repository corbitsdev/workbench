# @workbench/tools-linear

Linear GraphQL tools for workbench agents. The hub registry is
`LINEAR_HUB_TOOLS` in `src/hub-tools.ts` (**42** `linear_*` tools).

- **Read (26):** issues, comments, attachments (get), documents, projects,
  milestones, initiatives, releases, teams, users, cycles, labels (list),
  workflow states, search, views, webhooks (list), dashboards (list).
- **Write (16):** issue lifecycle and relations; save comment/document/project/
  milestone/initiative/release; issue labels; attachment upload flow; webhook
  save/delete.

Writes use `sideEffect: "write"` on each hub entry so the hub classifies them for
ReviewGate / grant `ask` in interactive sessions. See
[docs/LINEAR_TOOLS.md](../../docs/LINEAR_TOOLS.md) for the full catalog and
unsupported-operation matrix (no stub tools).

Module layout and wiring notes: [AGENTS.md](./AGENTS.md).
