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

## MCP

Myra can also reach any external MCP server: connect one in Plugins and
its tools become callable the same way a native `@corbits/*` tool is,
with no separate integration per server.

## Chat is mail

Talking to Myra, or to a teammate, is an ordinary mail thread — no
separate "chat" concept to learn, no bespoke room model. What you send
lands in an inbox; what she does happens through approvals you can see.
