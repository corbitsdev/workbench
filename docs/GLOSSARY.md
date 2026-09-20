# Glossary

Workbench's user-facing vocabulary, and how each term maps to the
[Interchange](https://github.com/faremeter/interchange) platform concept
underneath. Product surfaces (UI, docs) use the left column; code and API
paths keep the platform's own names.

| Product term | Platform term | What it is |
| ------------- | -------------- | ----------- |
| **Workspace** | tenant         | The top-level Interchange tenant every signed-up user gets — members, credentials, and grants live here at the root. |
| **Workbench (bench)** | tenant (child) | A child tenant `/new` creates under the workspace — a channel with many people and agents — with its own deployed agents. |
| **User**      | principal      | An identity that can act in a workspace or workbench — human or agent. |
| **Agent**     | principal (agent) | A named coworker principal, not a template. |
| **Myra**      | —              | The `assistant` workflow: every workspace's default agent. Given a job it can't already do, she authors a new tool, skill, or workflow as code, deploys it with only the access it needs, and uses it. |
| **Thread**    | mailbox thread | The ordered messages of one conversation, served by `@corbits/mailbox` (`GET /me/inbox/threads`, `POST /me/inbox/send`). |
| **Grant**     | grant          | Permission for a principal to act on a resource. |
| **Approval**  | approval       | A human decision gating an external side effect. |
| **Hub**       | hub            | The API and coordination service a workspace lives on. |
| **Sidecar**   | sidecar        | The execution host that runs agent turns and workflow runs for a hub. |

## Package naming

`@corbits/*` is the default scope for every package under `packages/`,
`tools/`, `agents/`, `skills/`, and `workflows/` — with a kebab-case kind
suffix where a package is one of a family (`-agent`, `-tools`).
