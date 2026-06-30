# @workbench/tools-vercel

Vercel static deployment tools. Registered as `vercel_*` tools and credentialed with the `vercel` provider.

- Tool credentials resolve through the credential rail; do not add `vercel` to agent `credentialRequirements`.
- Write actions (`vercel_deploy_static_file`) are human-in-the-loop: the agent must obtain approval through the real `ask_principal` gate (`@workbench/approvals`, backed by the hub approvals route and the ReviewGate UI) before deploying. The tool carries no self-attested `approved` flag — an LLM-supplied boolean is not a human signal. Hard enforcement (suspending the call itself) is a follow-up; today the gate is the `ask_principal` orchestration the tool description mandates.
- Read tools (`vercel_list_projects`, `vercel_list_deployments`) need no approval.
- Keep API response parsing strict enough to surface contract drift instead of silently fabricating deployment URLs.
