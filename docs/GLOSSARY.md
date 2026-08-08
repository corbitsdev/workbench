# Glossary

Workbench's user-facing vocabulary, and how each term maps to the
[Interchange](https://github.com/faremeter/interchange) platform concept
underneath. Product surfaces (UI, CLI output, docs) use the left column;
code and API paths keep the platform's own names.

| Product term     | Platform term                                      | What it is                                                                                                                                                                                                                                          |
| ---------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bench**        | tenant                                             | A shared space where a team and its agents work — members, definitions, runs, and grants live here                                                                                                                                                  |
| **User**         | principal                                          | An identity that can act in a bench — human or agent                                                                                                                                                                                                |
| **Definition**   | workflow definition                                | A deployable unit of agent behavior, authored as code                                                                                                                                                                                               |
| **Run**          | workflow run                                       | A definition executing in a bench; interactive runs carry conversations                                                                                                                                                                             |
| **Approval**     | approval                                           | A human decision gating an external side effect                                                                                                                                                                                                     |
| **Grant**        | grant                                              | Permission for a principal to act on a resource                                                                                                                                                                                                     |
| **Hub**          | hub                                                | The API and coordination service a bench lives on                                                                                                                                                                                                   |
| **Sidecar**      | sidecar                                            | The execution host that runs definitions on behalf of a hub                                                                                                                                                                                         |
| **Extension**    | —                                                  | A route factory mounted on the hub to add product surface                                                                                                                                                                                           |
| **Channel**      | folded interactive instance, itself a child tenant | A credential-free agent run whose mailbox is a shared conversation; also its own tenant, parented under the bench it was created in, so its membership and grants are its own — see [CHAT.md](CHAT.md) and [channel-tenancy.md](channel-tenancy.md) |
| **Channel host** | anchor run                                         | The long-lived run backing a channel; holds its mailbox but never replies                                                                                                                                                                           |
| **Timeline**     | —                                                  | A channel's mailbox, read back in order, as the conversation record                                                                                                                                                                                 |
| **Participant**  | —                                                  | An address (human or agent) a channel's settings list as able to post or be mentioned                                                                                                                                                               |
| **Handle**       | —                                                  | A participant's short, unique-within-channel mention name (e.g. `echo`), distinct from its address                                                                                                                                                  |
| **Mention**      | —                                                  | `@` plus a participant's handle in message text, triggering fan-out to that participant                                                                                                                                                             |
| **Reply bridge** | —                                                  | The bridge that turns an invited agent's `connector.reply` events into channel timeline messages                                                                                                                                                    |

A bench and a channel are both tenants underneath, which can read as the
same thing twice. They are not: a bench is the space a team provisions and
works in; a channel is a conversation that happens to be minted as a
tenant too, so it can carry its own membership and grants independent of
the bench it lives in. Every channel is a tenant, but a tenant a person
would call a "bench" is one nothing else is parented under as a channel —
in practice, the one they signed into, not one that showed up as a
conversation in their sidebar.

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
