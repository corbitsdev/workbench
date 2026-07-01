# @workbench/tools-fileparser

The `parse_file` tool — model-agnostic document understanding (CL-2628).

An agent whose own model cannot read documents (e.g. Myra on `kimi-k2.6` via
opencode-zen, whose adapter throws on document content blocks) calls
`parse_file(artifactId)`. The hub reads the uploaded file artifact (stored as a
`data:<mime>;base64,…` data URL) and runs a one-shot inference turn on the
Anthropic-bound **File Parser** definition (`packages/agents/src/file-parser`),
which marshals the bytes into a native document block and returns the extracted
text.

**Keyless — no seed entry.** This package holds only the tool definition and is
hub-backed: `defineHubBackedToolPackage` forwards every call to the hub's scoped
`/api/internal/hub-tools/run` endpoint. It has no provider credential of its own,
so it needs **no** entry in `seed-credentials.ts` and **no** `.env` var. The
parse turn resolves the tenant's existing `anthropic-api` inference credential
hub-side (the same one Fannie/Freddie use).

Hub execution: `apps/hub/src/lib/file-parser-tools.ts` → `parseDocument` in
`apps/hub/src/services/file-parser.ts`.
