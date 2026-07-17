# @workbench/tools-agents

Agent directory tools. Registered in the hub's tool registry as `list_agents` and `search_agents`.

- Context tools (no provider credential): they read the tenant's `agentInstance` rows (joined with `agent` for the name/description) directly from the Interchange db
- `list_agents` returns every agent instance visible to the caller; `search_agents` additionally requires a `query` and keyword-ranks by name/description match (name match weighted above description match), returning only agents that match — same fields as `list_agents` (name, description, mail address, status, definition id, instance id)
- Both share the same ownership resolution (`resolveOwnedInstanceIds` in `apps/hub/src/tools/list-agents.ts`): fail closed to an empty result for a caller whose owning member cannot be resolved, never a tenant-wide listing/search
- Neither computes "launchable by caller" — this seam has no data on credential requirements or deploy-descriptor visibility for arbitrary agent definitions, only on instances the caller's owner already has
- `invoke_agent` (write, approval-gated) delegates a brief to an agent DEFINITION found via `list_agents`/`search_agents`: the hub handler (`apps/hub/src/tools/invoke-agent.ts`) resolves the invoking member from the caller's `member_agent_instance` attribution (fail-closed), reuses or provisions an instance (principal + instance + attribution row written in one transaction before launch, under the `myra-invoked-subagent` template key — one instance per (member, definition), enforced by a partial unique index so concurrent invokes adopt the winner's row), never relaunches a routable instance (the launch step is serialized per instance in-process), refuses personal-agent definitions (shared specialists only — invocable by any tenant member), and delivers the brief as mail. Each mailed brief gets a fresh budget (the invoke director resets caps per message). The launch prompt carries the invoke-session marker (`@workbench/myra` `withInvokeSessionMarker`) so the sidecar selects the budget-capped invoke director; the return path (results flowing back to the invoking thread) is CL-3685, not this tool
- The tool grants (`tool:list_agents/invoke`, `tool:search_agents/invoke`) are synthesized at session launch from the agent's capabilities list; do not add them to the DB

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
