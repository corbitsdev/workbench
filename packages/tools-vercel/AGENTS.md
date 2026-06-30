# @workbench/tools-vercel

Vercel static deployment tools. Registered as `vercel_*` tools and credentialed with the `vercel` provider.

- Tool credentials resolve through the credential rail; do not add `vercel` to agent `credentialRequirements`.
- Write actions (`vercel_deploy_static_file`) are human-in-the-loop, enforced at the sidecar harness seam: `createApprovalGatedRunner` (in `apps/sidecar/src/approval-gate.ts`) intercepts the call, creates a hub `approval` record, and blocks on the ReviewGate UI before the tool runs — the model cannot route around it. The tool itself carries no approval logic and no self-attested flag. This is the stand-in for Interchange's native `ask` grant effect (unwired — CL-2591); when that lands, remove the gated-tool entry and flip the grant.
- Read tools (`vercel_list_projects`, `vercel_list_deployments`) need no approval.
- Keep API response parsing strict enough to surface contract drift instead of silently fabricating deployment URLs.
