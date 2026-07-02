# @workbench/tools-fileparser

The `parse_file` tool — model-agnostic document understanding (CL-2628). An
agent whose own model cannot read documents (e.g. Myra on kimi via
opencode-zen) calls `parse_file(artifactId)`; the hub reads the uploaded file
artifact and runs a one-shot Anthropic-bound parse turn (the seeded, non-chat
"File Parser" definition), returning the extracted text.

- Keyless — no provider credential of its own. The native `interchange.tools`
  factory (`defineHubBackedToolPackage`) declares the hub-RPC context as its
  only `requires` entry and forwards every call to the hub's scoped
  `/api/internal/hub-tools/run` endpoint. The parse turn resolves the
  tenant's `anthropic-api` inference credential hub-side via the File Parser
  definition. No seed entry needed here.
- Hub execution lives in `apps/hub/src/lib/file-parser-tools.ts`
  (`FILEPARSER_HUB_TOOLS`), which calls `parseDocument` in
  `apps/hub/src/services/file-parser.ts`.
- Tool grants are synthesized at session launch from the agent's capabilities
  list; do not add them to the DB.

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
