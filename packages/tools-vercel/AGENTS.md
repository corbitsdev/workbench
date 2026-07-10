# @workbench/tools-vercel

Vercel static deployment tools. Registered as `vercel_*` tools and credentialed with the `vercel` provider.

- Tool credentials resolve through the credential rail; do not add `vercel` to agent `credentialRequirements`.
- Write actions (`vercel_deploy_static_file`, hub-backed `vercel_deploy_artifact` for `web` / `web_site` artifacts) are human-in-the-loop, driven by Interchange's native `ask` grant effect. The hub stamps their `tool:<name>`/`invoke` grant `effect: "ask"` for the interactive agent (via `approvalGatedWriteNames` in `@workbench/agents` → `APPROVAL_GATED_TOOL_NAMES` in `apps/hub/src/lib/approval-gated-tools.ts`); the sidecar default harness's `createAskResolvingAuthorize` (in `apps/sidecar/src/approval-gate.ts`) resolves the ask through a hub `approval` record + the ReviewGate UI before the harness authz-extension permits the call. The tool itself carries no approval logic. Workflow step grants stay `allow`, so unattended runs never block.
- Read tools (`vercel_list_projects`, `vercel_list_deployments`) need no approval.
- Keep API response parsing strict enough to surface contract drift instead of silently fabricating deployment URLs.
