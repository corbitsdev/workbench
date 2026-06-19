# @workbench/tools-artifact

Workbench artifact tools (`artifact_*` and `write_artifact`). Hub-backed: the
tool definitions live here, but execution happens hub-side against the
artifact tables.

- Keyless — no provider credential. The native `interchange.tools` factory
  (`defineHubBackedToolPackage`) declares the hub-RPC context as its only
  `requires` entry and forwards every call to the hub's scoped
  `/api/internal/hub-tools/run` endpoint, which authorizes against the
  instance principal's grants. No seed entry needed.
- The hub keeps its execution functions (`createArtifactTools`,
  `createWriteArtifactTool`) but sources the definitions from this package.
- The tool grants are synthesized at session launch from the agent's
  capabilities list; do not add them to the DB.

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
