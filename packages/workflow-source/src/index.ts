// The one shape a `workflow`-kind asset may carry.
//
// Upstream retired the on-disk `workflow.json` envelope: the push
// validator (`vendor/intx/hub-sessions/src/workflow-kind.ts`,
// `workflowKindHandler.validatePush`) refuses a bare serialized
// definition and accepts only a source codebase — a `package.json`
// declaring `interchange.workflow` plus that entry module, which
// default-exports the definition. Every authoring path in this repo
// writes that tree through `renderWorkflowSourceTree` and recovers the
// definition back out of it through `parseWorkflowSourceEntry`, so the
// bytes on disk have exactly one producer and one consumer.
//
// `validate-push.test.ts` round-trips the rendered tree through the real
// `workflowKindHandler.validatePush`, so a renderer/validator drift fails a
// test here instead of surfacing as a push rejection on a workflow someone
// just created.
//
// The entry is a JSON literal rather than a call into a builder: an
// asset tree is a standalone codebase, so it can declare no workspace
// dependency to evaluate, and the definition it carries is inert data.
// That is what lets the reader below be a strict slice of a known
// prefix and suffix instead of an evaluation.

/** The entry module's path inside the asset tree. */
export const WORKFLOW_SOURCE_ENTRY_PATH = "workflow.js";
/** The `interchange.workflow` entry a code-sourced deploy names. */
export const WORKFLOW_SOURCE_ENTRY = `./${WORKFLOW_SOURCE_ENTRY_PATH}`;
/** The manifest's path inside the asset tree. */
export const WORKFLOW_SOURCE_MANIFEST_PATH = "package.json";
/** The path a pre-retirement asset carried its definition at. */
export const RETIRED_WORKFLOW_ENVELOPE_PATH = "workflow.json";

const ENTRY_PREFIX = "export default ";
const ENTRY_SUFFIX = ";\n";

export type WorkflowSourceTree = Readonly<Record<string, string>>;

/** The two-file source tree a serialized definition renders into. */
export function renderWorkflowSourceTree(args: {
  packageName: string;
  workflowJson: string;
}): WorkflowSourceTree {
  const packageJson = {
    name: args.packageName,
    version: "0.0.0",
    private: true,
    type: "module",
    interchange: { workflow: WORKFLOW_SOURCE_ENTRY },
  };
  return {
    [WORKFLOW_SOURCE_MANIFEST_PATH]: `${JSON.stringify(packageJson, null, 2)}\n`,
    [WORKFLOW_SOURCE_ENTRY_PATH]: `${ENTRY_PREFIX}${args.workflowJson}${ENTRY_SUFFIX}`,
  };
}

/**
 * Thrown when an asset does not carry the source form — in practice, an
 * asset last written before the retirement, whose tree still holds a
 * bare `workflow.json`. Named so every route boundary can answer it as
 * a client-visible conflict with re-authoring guidance rather than
 * letting it read as a server fault.
 */
export class RetiredWorkflowEnvelopeError extends Error {
  readonly assetId: string;

  constructor(assetId: string, options?: { cause?: unknown }) {
    super(
      `Asset "${assetId}" still carries the retired ${RETIRED_WORKFLOW_ENVELOPE_PATH} envelope ` +
        `instead of a ${WORKFLOW_SOURCE_ENTRY_PATH} source entry. Re-author and re-deploy the ` +
        `definition to write its source tree; nothing can read or edit it until then.`,
      options,
    );
    this.name = "RetiredWorkflowEnvelopeError";
    this.assetId = assetId;
  }
}

/**
 * Recovers the serialized definition from the exact bytes
 * `renderWorkflowSourceTree` emits. A strict single-shape slice, never
 * an evaluation: anything else is an asset this lineage did not author
 * in its current form.
 */
export function parseWorkflowSourceEntry(
  entryModule: string,
  assetId: string,
): string {
  if (
    !entryModule.startsWith(ENTRY_PREFIX) ||
    !entryModule.endsWith(ENTRY_SUFFIX)
  ) {
    throw new RetiredWorkflowEnvelopeError(assetId);
  }
  return entryModule.slice(
    ENTRY_PREFIX.length,
    entryModule.length - ENTRY_SUFFIX.length,
  );
}

/**
 * The blob read a source-form asset needs. Declared structurally so this
 * package stays dependency-free; `@intx/hub-sessions`' `AssetService`
 * satisfies it exactly.
 */
export type WorkflowSourceBlobReader = {
  readAssetBlob(params: { assetId: string; path: string }): Promise<Uint8Array>;
};

/**
 * Reads a source-form asset's serialized definition. A missing entry
 * module is the retirement's own failure mode — an asset written before
 * the cutover — so it surfaces as `RetiredWorkflowEnvelopeError` rather
 * than the asset service's generic not-found.
 */
export async function readWorkflowSourceDefinition(
  reader: WorkflowSourceBlobReader,
  assetId: string,
): Promise<string> {
  let entryBytes: Uint8Array;
  try {
    entryBytes = await reader.readAssetBlob({
      assetId,
      path: WORKFLOW_SOURCE_ENTRY_PATH,
    });
  } catch (cause) {
    throw new RetiredWorkflowEnvelopeError(assetId, { cause });
  }
  return parseWorkflowSourceEntry(
    new TextDecoder().decode(entryBytes),
    assetId,
  );
}
