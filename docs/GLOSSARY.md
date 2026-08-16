# Glossary

Workbench's user-facing vocabulary, and how each term maps to the
[Interchange](https://github.com/faremeter/interchange) platform concept
underneath. Product surfaces (UI, CLI output, docs) use the left column;
code and API paths keep the platform's own names.

| Product term     | Platform term                                 | What it is                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bench**        | tenant                                        | A shared space where a team and its agents work — members, definitions, runs, and grants live here                                                                                                                                                                                                                                                                               |
| **User**         | principal                                     | An identity that can act in a bench — human or agent                                                                                                                                                                                                                                                                                                                             |
| **Definition**   | workflow definition                           | A deployable unit of agent behavior, authored as code                                                                                                                                                                                                                                                                                                                            |
| **Run**          | workflow run                                  | A definition executing in a bench; interactive runs carry conversations                                                                                                                                                                                                                                                                                                          |
| **Routine**      | —                                             | The named parent entity over runs of one definition — a trigger (or none), a delivery channel, and its run history; see [`@corbits/routines`](../packages/routines/README.md)                                                                                                                                                                                                    |
| **Approval**     | approval                                      | A human decision gating an external side effect                                                                                                                                                                                                                                                                                                                                  |
| **Grant**        | grant                                         | Permission for a principal to act on a resource                                                                                                                                                                                                                                                                                                                                  |
| **Hub**          | hub                                           | The API and coordination service a bench lives on                                                                                                                                                                                                                                                                                                                                |
| **Sidecar**      | sidecar                                       | The execution host that runs definitions on behalf of a hub                                                                                                                                                                                                                                                                                                                      |
| **Extension**    | —                                             | A route factory mounted on the hub to add product surface                                                                                                                                                                                                                                                                                                                        |
| **Workbenches**  | —                                             | The sidebar's one list: every conversation in the selected bench, flat — no kind sections                                                                                                                                                                                                                                                                                        |
| **Workbench**    | channel (`kind: "chat"` or `kind: "channel"`) | The one conversation surface: an agent conversation (named by its agent) or a multi-party conversation (named by its own title) — a credential-free agent run whose mailbox is the conversation; also its own tenant, parented under the bench it was created in, so its membership and grants are its own — see [CHAT.md](CHAT.md) and [channel-tenancy.md](channel-tenancy.md) |
| **Channel host** | anchor run                                    | The long-lived run backing a workbench; holds its mailbox but never replies                                                                                                                                                                                                                                                                                                      |
| **Timeline**     | —                                             | A channel's mailbox, read back in order, as the conversation record                                                                                                                                                                                                                                                                                                              |
| **Participant**  | —                                             | An address (human or agent) a channel's settings list as able to post or be mentioned                                                                                                                                                                                                                                                                                            |
| **Handle**       | —                                             | A participant's short, unique-within-channel mention name (e.g. `echo`), distinct from its address                                                                                                                                                                                                                                                                               |
| **Mention**      | —                                             | `@` plus a participant's handle in message text, triggering fan-out to that participant                                                                                                                                                                                                                                                                                          |
| **Reply bridge** | —                                             | The bridge that turns an invited agent's `connector.reply` events into channel timeline messages                                                                                                                                                                                                                                                                                 |
| **Task**         | —                                             | A spawn-and-return prompt to one agent, private to the person who started it; its result reaches the Inbox, never a live view of the run — see [`@corbits/tasks`](../packages/tasks/README.md)                                                                                                                                                                                   |
| **Working**      | —                                             | The sidebar list's group for the signed-in user's tasks still in progress; a task drops out on the list's next refresh after it completes or fails, once its result has moved to the Inbox                                                                                                                                                                                       |

A bench and a workbench are both tenants underneath, which can read as
the same thing twice. They are not: a bench is the scope a team
provisions and works in (the switcher's rows); a workbench is a
conversation that happens to be minted as a tenant too (the platform's
"channel"), so it can carry its own membership and grants independent of
the bench it lives in. Every workbench is a tenant, but a tenant a person
would call a "bench" is one nothing else is parented under as a
workbench — in practice, the one they signed into, not one that showed up
as a conversation in their sidebar.

A **Routine** is never a second name for a **Run**, or for Interchange's
own workflow concept — the three sit at different levels. A workflow
definition is the deployable code; a run is one execution of it; a routine
is the named, recurring (or manual) parent a person sets up over runs of a
definition, holding the trigger, delivery channel, and run history a bare
run does not carry. "Workflow" on its own always means Interchange's
runtime concept — the definition or its runs — never a stand-in for
routine.

Naming conventions for this repository's packages:

- Local packages are `@workbench/*`, with a kebab-case kind suffix where
  the package is one of a family — `-agent`, `-tool`.
- Deployable definition packages are `@corbits/*` with a kind suffix
  naming what they are — `@corbits/<name>-agent` for agents,
  `@corbits/<name>-workflow` for plain workflows (e.g.
  `@corbits/echo-workflow`). They are portable artifacts that deploy on
  any Interchange instance and carry no reference to the host application.
- Packages destined to graduate into their own repositories are also
  `@corbits/*` (e.g. [`@corbits/react-ui`](https://github.com/corbitsdev/react-ui)).
