# Product

Workbench's product is Myra: an AI coworker who lives in your inbox and
gets things done through tools, not a chat toy bolted onto a workflow
builder.

## Myra

Myra (`agents/myra`) is the one agent Workbench ships. She isn't a
template you configure — she's a coworker you talk to. Ask her for a
capability the team doesn't have yet, and she writes it: a new tool, a
new skill, or a scheduled workflow, deployed as code, granted only the
access it needs. There's no catalog of pre-built workflows to browse
because there doesn't need to be one.

## Tools and skills

Myra's capabilities come from `@corbits/*` tool and skill packages —
connecting a mail account, searching the web, reading a linked repo,
running a scheduled digest. Anyone can author a new one; Myra reuses an
existing teammate's capability before duplicating it.

## Three tool surfaces

- **Myra is static.** She carries one small, fixed set: mail, her
  working tree, artifacts, memory, and web search. Complex work she hands
  to agents she creates rather than growing her own tool list.
- **Agents are granular.** A created agent carries exactly the MCP
  servers its job needs, so its definition stays polished and every
  remote tool is its own approval decision.
- **Chat is dynamic.** A chat gets the whole workspace catalog: every
  tool asks by default, read-only tools are allowed, and the model only
  sees a tool once it has searched for it.

## MCP

The workspace has one MCP catalog: connect a server in Tools (Exa is
there from day one, keyless) and its tools become callable the same way a
native `@corbits/*` tool is, with no separate integration per server.
Chat draws from the whole catalog; an agent is given the servers it
needs.

## Chat is mail

Talking to Myra, or to a teammate, is an ordinary mail thread — no
separate "chat" concept to learn, no bespoke conversation model. What you send
lands in an inbox; what she does happens through approvals you can see.
