// The one shape a `workflow`-kind asset may carry: a source codebase, per
// upstream's push validator. Every tree carries the executable entry the
// platform evaluates plus a `definition.json` projection readers parse —
// a bundled entry is code, so slicing it back apart is not an option.

/** The entry module's path inside the asset tree. */
export const WORKFLOW_SOURCE_ENTRY_PATH = "workflow.js";
/** The `interchange.workflow` entry a code-sourced deploy names. */
export const WORKFLOW_SOURCE_ENTRY = `./${WORKFLOW_SOURCE_ENTRY_PATH}`;
/** The directors module's path inside the asset tree. */
export const WORKFLOW_SOURCE_DIRECTORS_PATH = "directors.js";
/** The `interchange.directors` entry the run child loads a definition's
 * own directors from. */
export const WORKFLOW_SOURCE_DIRECTORS = `./${WORKFLOW_SOURCE_DIRECTORS_PATH}`;
/** The manifest's path inside the asset tree. */
export const WORKFLOW_SOURCE_MANIFEST_PATH = "package.json";
/** The JSON projection of the definition, for readers. */
export const WORKFLOW_SOURCE_DEFINITION_PATH = "definition.json";
/** The path a pre-retirement asset carried its definition at. */
export const RETIRED_WORKFLOW_ENVELOPE_PATH = "workflow.json";

export type WorkflowSourceTree = Readonly<Record<string, string>>;

function manifestFor(packageName: string): string {
  return `${JSON.stringify(
    {
      name: packageName,
      version: "0.0.0",
      private: true,
      type: "module",
      interchange: {
        workflow: WORKFLOW_SOURCE_ENTRY,
        directors: WORKFLOW_SOURCE_DIRECTORS,
      },
    },
    null,
    2,
  )}\n`;
}

/** The source tree a bundled entry renders into. `bundle` is one
 * self-contained ESM module exporting `buildExport`; the trailing call
 * supplies the per-deploy values and is what the platform evaluates.
 * `directorsBundle` is the `interchange.directors` module, pushed beside the
 * entry because the run child loads a definition's own directors from the
 * closure rather than from the entry's exports.
 * `workflowJson` is the same definition's function-free projection. */
export function renderBundledWorkflowSourceTree(args: {
  packageName: string;
  bundle: string;
  directorsBundle: string;
  buildExport: string;
  buildInput: unknown;
  workflowJson: string;
}): WorkflowSourceTree {
  const call = `${args.buildExport}(${JSON.stringify(args.buildInput)})`;
  return {
    [WORKFLOW_SOURCE_MANIFEST_PATH]: manifestFor(args.packageName),
    [WORKFLOW_SOURCE_ENTRY_PATH]: `${args.bundle}\nexport default ${call};\n`,
    [WORKFLOW_SOURCE_DIRECTORS_PATH]: args.directorsBundle,
    [WORKFLOW_SOURCE_DEFINITION_PATH]: `${args.workflowJson}\n`,
  };
}

/** Thrown when an asset carries no readable `definition.json`, so a route
 * boundary can answer it as a client-visible conflict. */
export class RetiredWorkflowEnvelopeError extends Error {
  readonly assetId: string;

  constructor(assetId: string, options?: { cause?: unknown }) {
    super(
      `Asset "${assetId}" carries no ${WORKFLOW_SOURCE_DEFINITION_PATH} beside its ` +
        `${WORKFLOW_SOURCE_ENTRY_PATH} source entry. Re-author and re-deploy the definition ` +
        `to write its source tree; nothing can read or edit it until then.`,
      options,
    );
    this.name = "RetiredWorkflowEnvelopeError";
    this.assetId = assetId;
  }
}

/** Validates the bytes at `definition.json` are the serialized definition
 * and answers them verbatim, so callers keep byte-faithful JSON. */
export function parseWorkflowSourceDefinition(definitionJson: string, assetId: string): string {
  const trimmed = definitionJson.trim();
  try {
    JSON.parse(trimmed);
  } catch (cause) {
    throw new RetiredWorkflowEnvelopeError(assetId, { cause });
  }
  return trimmed;
}

/** The blob read a source-form asset needs, declared structurally so this
 * package stays dependency-free. */
export type WorkflowSourceBlobReader = {
  readAssetBlob(params: { assetId: string; path: string }): Promise<Uint8Array>;
};

/** Reads a source-form asset's serialized definition. A missing projection
 * surfaces as `RetiredWorkflowEnvelopeError`, not a generic not-found. */
export async function readWorkflowSourceDefinition(
  reader: WorkflowSourceBlobReader,
  assetId: string,
): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await reader.readAssetBlob({
      assetId,
      path: WORKFLOW_SOURCE_DEFINITION_PATH,
    });
  } catch (cause) {
    throw new RetiredWorkflowEnvelopeError(assetId, { cause });
  }
  return parseWorkflowSourceDefinition(new TextDecoder().decode(bytes), assetId);
}
