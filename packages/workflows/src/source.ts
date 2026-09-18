// The one shape a `workflow`-kind asset may carry: a source codebase, per
// upstream's push validator. `renderWorkflowSourceTree` and
// `parseWorkflowSourceEntry` are its one producer and consumer.

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

/** Thrown when an asset still carries the retired bare `workflow.json`
 * envelope, so a route boundary can answer it as a client-visible conflict. */
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

/** Recovers the serialized definition from the exact bytes
 * `renderWorkflowSourceTree` emits — a strict slice, never an evaluation. */
export function parseWorkflowSourceEntry(entryModule: string, assetId: string): string {
  if (!entryModule.startsWith(ENTRY_PREFIX) || !entryModule.endsWith(ENTRY_SUFFIX)) {
    throw new RetiredWorkflowEnvelopeError(assetId);
  }
  return entryModule.slice(ENTRY_PREFIX.length, entryModule.length - ENTRY_SUFFIX.length);
}

/** The blob read a source-form asset needs, declared structurally so this
 * package stays dependency-free. */
export type WorkflowSourceBlobReader = {
  readAssetBlob(params: { assetId: string; path: string }): Promise<Uint8Array>;
};

/** Reads a source-form asset's serialized definition. A missing entry
 * module surfaces as `RetiredWorkflowEnvelopeError`, not a generic not-found. */
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
  return parseWorkflowSourceEntry(new TextDecoder().decode(entryBytes), assetId);
}
