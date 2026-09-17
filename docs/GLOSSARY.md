# Glossary

Workbench's user-facing vocabulary, and how each term maps to the
[Interchange](https://github.com/faremeter/interchange) platform concept
underneath. Product surfaces (UI, docs) use the left column; code and API
paths keep the platform's own names.

| Product term | Platform term | What it is |
| ------------- | -------------- | ----------- |
| **Bench**     | tenant         | The shared space a team and its agents work in — members, credentials, and grants live here. Every signed-up user gets one; there is no separate tenancy layer underneath it. |
| **User**      | principal      | An identity that can act in a bench — human or agent. |
| **Agent**     | principal (agent) | A named coworker principal, not a template. |
| **Myra**      | —              | The `assistant` workflow: every bench's default agent. Given a job the bench can't already do, she authors a new tool, skill, or workflow as code, deploys it with only the access it needs, and uses it. |
| **Workbench** | —              | A conversation — a mail thread, or the group of threads with one agent or one topic. Talking to Myra or a teammate happens here. |
| **Thread**    | mailbox thread | The ordered messages of one conversation, served by `@corbits/mailbox` (`GET /me/inbox/threads`, `POST /me/inbox/send`). |
| **Grant**     | grant          | Permission for a principal to act on a resource. |
| **Approval**  | approval       | A human decision gating an external side effect. |
| **Hub**       | hub            | The API and coordination service a bench lives on. |
| **Sidecar**   | sidecar        | The execution host that runs agent turns and workflow runs for a hub. |

## Package naming

`@corbits/*` is the default scope for every package under `packages/`,
`tools/`, `agents/`, `skills/`, and `workflows/` — with a kebab-case kind
suffix where a package is one of a family (`-agent`, `-tools`).
