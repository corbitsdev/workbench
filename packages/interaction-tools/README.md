# @corbits/interaction-tools

The `ask_user` tool: an `@intx/agent` bundle that poses an interview
question in-thread as an interactive question block, then ends the turn.
A Workbench agent treats "ask a person" as native — post the question
and stop — rather than a structural park: the person's answer arrives as
the agent's next inbound message, not as this call's result.

See `./src/tool.ts` for the tool definition and `./src/client.ts` for
the hub call that posts the question block.
