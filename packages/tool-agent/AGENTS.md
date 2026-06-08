# @workbench/tool-agent

Scaffold template for new agent packages. Copy this directory to create a new agent; do not use it directly.

- Follow the inline comments in `definition.ts` to fill in the agent name, system prompt, credential requirements, and capabilities
- Wire provisioning in `apps/hub/src/lib/tenant-provisioning.ts` after creating the package
- Tool names in `capabilities.tools` must match keys in the hub's `tool-registry.ts`
