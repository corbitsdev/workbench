const WORKFLOW_SOURCE_ENTRY_PATH = "workflow.js";
const WORKFLOW_SOURCE_ENTRY = `./${WORKFLOW_SOURCE_ENTRY_PATH}`;
const WORKFLOW_SOURCE_DIRECTORS_PATH = "directors.js";
const WORKFLOW_SOURCE_DIRECTORS = `./${WORKFLOW_SOURCE_DIRECTORS_PATH}`;
const WORKFLOW_SOURCE_MANIFEST_PATH = "package.json";
export const WORKFLOW_SOURCE_DEFINITION_PATH = "definition.json";

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

export function renderBundledWorkflowSourceTree(args: {
  packageName: string;
  bundle: string;
  directorsBundle: string;
  buildExport: string;
  buildInput: unknown;
  workflowJson: string;
}): Readonly<Record<string, string>> {
  const call = `${args.buildExport}(${JSON.stringify(args.buildInput)})`;
  return {
    [WORKFLOW_SOURCE_MANIFEST_PATH]: manifestFor(args.packageName),
    [WORKFLOW_SOURCE_ENTRY_PATH]: `${args.bundle}\nexport default ${call};\n`,
    [WORKFLOW_SOURCE_DIRECTORS_PATH]: args.directorsBundle,
    [WORKFLOW_SOURCE_DEFINITION_PATH]: `${args.workflowJson}\n`,
  };
}

class RetiredWorkflowEnvelopeError extends Error {
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

export function parseWorkflowSourceDefinition(definitionJson: string, assetId: string): string {
  const trimmed = definitionJson.trim();
  try {
    JSON.parse(trimmed);
  } catch (cause) {
    throw new RetiredWorkflowEnvelopeError(assetId, { cause });
  }
  return trimmed;
}
