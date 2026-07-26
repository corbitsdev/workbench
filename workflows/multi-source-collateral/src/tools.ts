import { createToolRunner } from "@intx/agent";
import type { AgentTool, AgentToolRunner, BaseEnv } from "@intx/agent";
import type { ToolDefinition, ToolResult } from "@intx/types/runtime";
import { getToolCredential } from "@workbench/tool-credentials";
import {
  defineCredentialedToolPackage,
  defineHubBackedToolPackage,
} from "@workbench/tool-credentials/factory";
import { withToleranceEnvelope } from "@workbench/tool-credentials/tolerance-envelope-dispatch";
import { ARTIFACT_TOOL_DEFINITIONS } from "@workbench/tools-artifact";
import { createGranolaTools } from "@workbench/tools-granola";
import type { GranolaToolsConfig } from "@workbench/tools-granola";
import { LINEAR_HUB_TOOLS, createLinearTools } from "@workbench/tools-linear";
import type { LinearToolsConfig } from "@workbench/tools-linear";
import { CONTENT_TYPES } from "./prompts";
import {
  buildSourceContext,
  extractArtifactText,
  extractIssueText,
  extractNoteText,
  parseArtifactList,
  parseGeneratedPieces,
  parseIssueList,
  parseNoteList,
  type ArtifactItem,
  type LinearIssueItem,
  type NoteItem,
} from "./parse";

// This file consolidates every workflow-owned tool for
// multi-source-collateral: the tolerant Linear source lister, the three
// gate-builder tools that shape prior-step output into the `form`/
// `reviewList` UIBlocks the STEP_UI gates render (`gateFromOutput`), the
// folded fetch/persist tools that replace the retired `map`-over-
// deterministic-tool pattern (a native `action` cannot be a `map`'s inner
// step — see index.ts), and the item-builder that turns picked options into
// per-piece generate payloads.

function coerceArgsObject(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof args._raw === "string") {
    const parsed: unknown = JSON.parse(args._raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("_raw fallback is not a JSON object");
    }
    return parsed as Record<string, unknown>;
  }
  return args;
}

function fail(callId: string, message: string): ToolResult {
  return { callId, isError: true, content: message };
}

function ok(callId: string, content: unknown): ToolResult {
  return { callId, content: content as string | Record<string, unknown> };
}

/** Like `coerceArgsObject`, but permissive of an ARRAY-shaped `_raw` payload —
 * the `generate`/`regenerate` map's own step output is an array of pieces,
 * not an object, so the sidecar's action dispatcher wraps it under `_raw`
 * the same way it wraps any non-object step input. */
function coerceArgsValue(args: Record<string, unknown>): unknown {
  if (typeof args._raw === "string") {
    return JSON.parse(args._raw);
  }
  return args;
}

// ---------------------------------------------------------------------------
// list-issues — tolerant. Linear may be unconfigured; that must not fail the
// multi-source chooser. Calls the real `linear_list_issues` in-process over
// the same credentialed rail the standalone tools-linear package uses, and
// returns a completed non-error envelope on failure instead of throwing —
// the native `action` dispatch path has no `nonFatal` escape.
// ---------------------------------------------------------------------------

export const MULTI_SOURCE_COLLATERAL_LIST_ISSUES_DEFINITION: ToolDefinition = {
  name: "multi_source_collateral_list_issues",
  description:
    "Internal workflow helper. Lists Linear issues for the source picker, tolerating an unconfigured or failing Linear provider instead of failing the run.",
  inputSchema: {
    type: "object",
    properties: {
      first: {
        type: "number",
        description: "Maximum number of issues to return.",
      },
    },
  },
};

const LINEAR_LIST_ISSUES_ENTRY = LINEAR_HUB_TOOLS.linear_list_issues;
if (LINEAR_LIST_ISSUES_ENTRY === undefined) {
  throw new Error(
    "@workbench/tools-linear no longer exports linear_list_issues",
  );
}

const listIssuesInner = defineCredentialedToolPackage({
  id: "@workbench/workflow-multi-source-collateral/list-issues-inner",
  provider: "linear",
  entries: { linear_list_issues: LINEAR_LIST_ISSUES_ENTRY },
});

/** Env keys `list-issues` needs injected — re-exported so `interchange-tools.ts`
 * stays a single source of truth with this file. */
export const LIST_ISSUES_TOOL_REQUIRES = [...listIssuesInner.requires];

function createListIssuesTool(env: Record<string, unknown>): AgentTool {
  return {
    kind: "full",
    definition: MULTI_SOURCE_COLLATERAL_LIST_ISSUES_DEFINITION,
    handler: async (call, signal) => {
      const args = coerceArgsObject(call.arguments);
      return withToleranceEnvelope(call.id, () => {
        // Constructed lazily, inside the handler: a tenant with no Linear
        // credential must not fail every OTHER tool this factory builds.
        const inner = listIssuesInner(env as unknown as BaseEnv);
        return inner.run(
          { id: call.id, name: "linear_list_issues", arguments: args },
          signal,
        );
      });
    },
  };
}

// ---------------------------------------------------------------------------
// prepare-sources-gate — fatal. Shapes list-artifacts/list-notes/list-issues
// into the `form` UIBlock the `sources` gate's STEP_UI entry renders via
// gateFromOutput: a multiSelect of every listed artifact/note/issue plus a
// free-text field, so a run with no sources at all still lets the human
// paste free text.
// ---------------------------------------------------------------------------

export const MULTI_SOURCE_COLLATERAL_PREPARE_SOURCES_GATE_DEFINITION: ToolDefinition =
  {
    name: "multi_source_collateral_prepare_sources_gate",
    description:
      "Internal workflow helper. Shapes the listed artifacts/notes/issues into the form UIBlock the sources gate's STEP_UI entry renders via gateFromOutput.",
    inputSchema: { type: "object", properties: {} },
  };

function optionsFor(
  prefix: "artifact" | "note" | "issue",
  items: { id: string; label: string }[],
): { value: string; label: string }[] {
  return items.map((item) => ({
    value: `${prefix}:${item.id}`,
    label: item.label,
  }));
}

function artifactLabel(item: ArtifactItem): string {
  return item.title ?? item.id;
}

function noteLabel(item: NoteItem): string {
  return item.title ?? item.id;
}

function issueLabel(item: LinearIssueItem): string {
  const identifier = item.identifier ?? item.id;
  return item.title ? `${identifier}: ${item.title}` : identifier;
}

function createPrepareSourcesGateTool(): AgentTool {
  return {
    kind: "full",
    definition: MULTI_SOURCE_COLLATERAL_PREPARE_SOURCES_GATE_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const artifacts = parseArtifactList(args);
      const notes = parseNoteList(args);
      const issues = parseIssueList(args);
      const options = [
        ...optionsFor(
          "artifact",
          artifacts.status === "ok"
            ? artifacts.value.map((a) => ({
                id: a.id,
                label: artifactLabel(a),
              }))
            : [],
        ),
        ...optionsFor(
          "note",
          notes.status === "ok"
            ? notes.value.map((n) => ({ id: n.id, label: noteLabel(n) }))
            : [],
        ),
        ...optionsFor(
          "issue",
          issues.status === "ok"
            ? issues.value.map((i) => ({ id: i.id, label: issueLabel(i) }))
            : [],
        ),
      ];
      return ok(call.id, {
        kind: "form",
        prompt:
          "Pick artifacts, Granola notes, and/or Linear issues to draw from, and/or paste free text.",
        submitLabel: "Continue",
        fields: [
          {
            kind: "multiSelect",
            name: "sourceIds",
            label: "Sources",
            options,
          },
          {
            kind: "textarea",
            name: "freeText",
            label: "Free text (optional)",
            placeholder: "Paste any additional source material here.",
          },
        ],
      });
    },
  };
}

// ---------------------------------------------------------------------------
// fetch-sources — fatal. Replaces the former per-kind `map`s (fetch-artifact/
// fetch-note/fetch-issue): `MapPrimitive.step` is a `StepPrimitive`, and an
// `action` cannot be a map's inner step at all (the deploy capability walk
// only reads `primitive.step.agent` for a map node), so the per-id fan-out
// moves inside this ONE tool, mirroring sumble-account-intel's
// `enrich-contacts` fold. Each selected id is dispatched to the matching
// underlying read tool (artifact_read / granola_get_note / linear_get_issue)
// in parallel; a genuine failure on ANY selected source fails the whole
// step, matching the original deterministicToolStep steps' fatal semantics
// (no `nonFatal` was ever set on them).
// ---------------------------------------------------------------------------

export const MULTI_SOURCE_COLLATERAL_FETCH_SOURCES_DEFINITION: ToolDefinition =
  {
    name: "multi_source_collateral_fetch_sources",
    description:
      "Internal workflow helper. Fetches every selected artifact/note/issue by id and combines them (plus any pasted free text) into a single source-context string. Fatal — a failed fetch for a selected source fails the run.",
    inputSchema: {
      type: "object",
      properties: {
        sourceIds: {
          type: "array",
          items: { type: "string" },
          description:
            'Selected ids, each prefixed "artifact:"/"note:"/"issue:".',
        },
        freeText: { type: "string", description: "Optional pasted free text." },
      },
    },
  };

type SourceKind = "artifact" | "note" | "issue";

function splitSourceId(
  sourceId: string,
): { kind: SourceKind; id: string } | null {
  const separatorIndex = sourceId.indexOf(":");
  if (separatorIndex === -1) return null;
  const kind = sourceId.slice(0, separatorIndex);
  const id = sourceId.slice(separatorIndex + 1);
  if (kind !== "artifact" && kind !== "note" && kind !== "issue") return null;
  if (id.length === 0) return null;
  return { kind, id };
}

const artifactInner = defineHubBackedToolPackage({
  id: "@workbench/workflow-multi-source-collateral/artifact-inner",
  definitions: ARTIFACT_TOOL_DEFINITIONS,
});

function createArtifactRunner(env: Record<string, unknown>) {
  return artifactInner(env as unknown as BaseEnv);
}

function createGranolaRunner(env: Record<string, unknown>): AgentToolRunner {
  const credential = getToolCredential(env, "granola");
  return createToolRunner(
    createGranolaTools({
      apiKey: credential.apiKey,
      baseUrl: credential.baseURL,
    } satisfies GranolaToolsConfig),
  );
}

function createLinearRunner(env: Record<string, unknown>): AgentToolRunner {
  const credential = getToolCredential(env, "linear");
  return createToolRunner(
    createLinearTools({
      apiKey: credential.apiKey,
      baseUrl: credential.baseURL,
    } satisfies LinearToolsConfig),
  );
}

async function fetchOneSource(
  sourceId: string,
  env: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ kind: SourceKind; id: string; text: string }> {
  const split = splitSourceId(sourceId);
  if (split === null) {
    throw new Error(`unrecognised source id "${sourceId}"`);
  }
  if (split.kind === "artifact") {
    const runner = createArtifactRunner(env);
    const result = await runner.run(
      {
        id: sourceId,
        name: "artifact_read",
        arguments: { artifactId: split.id },
      },
      signal,
    );
    if (result.isError === true) {
      throw new Error(
        `artifact_read failed for ${split.id}: ${String(result.content)}`,
      );
    }
    return { ...split, text: extractArtifactText(result.content) };
  }
  if (split.kind === "note") {
    const runner = createGranolaRunner(env);
    const result = await runner.run(
      {
        id: sourceId,
        name: "granola_get_note",
        arguments: { noteId: split.id },
      },
      signal,
    );
    if (result.isError === true) {
      throw new Error(
        `granola_get_note failed for ${split.id}: ${String(result.content)}`,
      );
    }
    return { ...split, text: extractNoteText(result.content) };
  }
  const runner = createLinearRunner(env);
  const result = await runner.run(
    { id: sourceId, name: "linear_get_issue", arguments: { id: split.id } },
    signal,
  );
  if (result.isError === true) {
    throw new Error(
      `linear_get_issue failed for ${split.id}: ${String(result.content)}`,
    );
  }
  return { ...split, text: extractIssueText(result.content) };
}

function createFetchSourcesTool(env: Record<string, unknown>): AgentTool {
  return {
    kind: "full",
    definition: MULTI_SOURCE_COLLATERAL_FETCH_SOURCES_DEFINITION,
    handler: async (call, signal) => {
      const args = coerceArgsObject(call.arguments);
      const sourceIds = Array.isArray(args.sourceIds)
        ? args.sourceIds.filter((id): id is string => typeof id === "string")
        : [];
      const freeText =
        typeof args.freeText === "string" ? args.freeText : undefined;
      let fetched: { kind: SourceKind; id: string; text: string }[];
      try {
        fetched = await Promise.all(
          sourceIds.map((sourceId) => fetchOneSource(sourceId, env, signal)),
        );
      } catch (err) {
        return fail(call.id, err instanceof Error ? err.message : String(err));
      }
      const sourceContext = buildSourceContext({
        artifactOutputs: fetched
          .filter((f) => f.kind === "artifact")
          .map((f) => f.text),
        noteOutputs: fetched
          .filter((f) => f.kind === "note")
          .map((f) => f.text),
        issueOutputs: fetched
          .filter((f) => f.kind === "issue")
          .map((f) => f.text),
        ...(freeText !== undefined ? { text: freeText } : {}),
      });
      return ok(call.id, {
        sourceContext,
        sourcesSummary: fetched.map(({ kind, id }) => ({ kind, id })),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// prepare-options-gate — fatal. Shapes the fetched source-context into the
// `form` UIBlock the `options` gate's STEP_UI entry renders via
// gateFromOutput: content-type multiSelect (capped at MAX_CONTENT_TYPES) plus
// optional audience/tone/goal/titleHint/promptOverride fields.
// ---------------------------------------------------------------------------

export const MULTI_SOURCE_COLLATERAL_PREPARE_OPTIONS_GATE_DEFINITION: ToolDefinition =
  {
    name: "multi_source_collateral_prepare_options_gate",
    description:
      "Internal workflow helper. Shapes the fetched source count into the form UIBlock the options gate's STEP_UI entry renders via gateFromOutput.",
    inputSchema: {
      type: "object",
      properties: {
        sourcesSummary: { type: "array", items: { type: "object" } },
      },
    },
  };

function createPrepareOptionsGateTool(): AgentTool {
  return {
    kind: "full",
    definition: MULTI_SOURCE_COLLATERAL_PREPARE_OPTIONS_GATE_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const sourcesSummary = Array.isArray(args.sourcesSummary)
        ? args.sourcesSummary
        : [];
      return ok(call.id, {
        kind: "form",
        prompt: `Pull from ${String(sourcesSummary.length)} source(s). Pick content types and, optionally, guidance for every piece.`,
        submitLabel: "Generate",
        fields: [
          {
            kind: "multiSelect",
            name: "contentTypes",
            label: "Content types",
            options: CONTENT_TYPES.map((t) => ({
              value: t.id,
              label: t.label,
            })),
          },
          { kind: "text", name: "audience", label: "Audience (optional)" },
          { kind: "text", name: "tone", label: "Tone (optional)" },
          { kind: "text", name: "goal", label: "Goal (optional)" },
          { kind: "text", name: "titleHint", label: "Title hint (optional)" },
          {
            kind: "textarea",
            name: "promptOverride",
            label: "Extra instructions (optional)",
          },
        ],
      });
    },
  };
}

// ---------------------------------------------------------------------------
// build-generate-items — fatal. Combines the fetched source context with the
// picked content types/options into one generate payload per selected
// content type — the `items` the `generate` map fans out over.
// ---------------------------------------------------------------------------

export const MULTI_SOURCE_COLLATERAL_BUILD_GENERATE_ITEMS_DEFINITION: ToolDefinition =
  {
    name: "multi_source_collateral_build_generate_items",
    description:
      "Internal workflow helper. Builds one generate payload per selected content type from the fetched source context and picked options.",
    inputSchema: {
      type: "object",
      properties: {
        sourceContext: { type: "string" },
        contentTypes: { type: "array", items: { type: "string" } },
      },
      required: ["sourceContext", "contentTypes"],
    },
  };

function createBuildGenerateItemsTool(): AgentTool {
  return {
    kind: "full",
    definition: MULTI_SOURCE_COLLATERAL_BUILD_GENERATE_ITEMS_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const sourceContext = args.sourceContext;
      const contentTypes = args.contentTypes;
      if (typeof sourceContext !== "string") {
        return fail(call.id, "sourceContext is required");
      }
      if (!Array.isArray(contentTypes) || contentTypes.length === 0) {
        return fail(call.id, "at least one contentType is required");
      }
      const audience =
        typeof args.audience === "string" ? args.audience : undefined;
      const tone = typeof args.tone === "string" ? args.tone : undefined;
      const goal = typeof args.goal === "string" ? args.goal : undefined;
      const titleHint =
        typeof args.titleHint === "string" ? args.titleHint : undefined;
      const promptOverride =
        typeof args.promptOverride === "string"
          ? args.promptOverride
          : undefined;
      const items = contentTypes
        .filter((c): c is string => typeof c === "string")
        .map((contentType) => ({
          contentType,
          format: contentType,
          sourceContext,
          ...(audience !== undefined ? { audience } : {}),
          ...(tone !== undefined ? { tone } : {}),
          ...(goal !== undefined ? { goal } : {}),
          ...(titleHint !== undefined ? { titleHint } : {}),
          ...(promptOverride !== undefined
            ? { systemPrompt: promptOverride }
            : {}),
        }));
      return ok(call.id, { items });
    },
  };
}

// ---------------------------------------------------------------------------
// prepare-review-gate / prepare-review-final-gate — fatal. Shapes the
// generate/regenerate map's parsed pieces into the `reviewList` UIBlock the
// `review`/`review-final` gates render via gateFromOutput.
// ---------------------------------------------------------------------------

const REVIEW_LIST_DISPLAY_FIELDS = [
  { key: "format", label: "Format", kind: "badge" as const },
  { key: "title", label: "Title" },
];

function buildReviewListBlock(raw: unknown, prompt: string): unknown {
  const pieces = parseGeneratedPieces(raw);
  return {
    kind: "reviewList",
    title: "Review the drafts",
    prompt,
    submitLabel: "Save approved",
    approvedKey: "approvedPieces",
    displayFields: REVIEW_LIST_DISPLAY_FIELDS,
    rows: pieces.map((piece, index) => ({
      id: `piece-${String(index)}`,
      fields: { format: piece.format, title: piece.title },
      payload: piece,
    })),
  };
}

export const MULTI_SOURCE_COLLATERAL_PREPARE_REVIEW_GATE_DEFINITION: ToolDefinition =
  {
    name: "multi_source_collateral_prepare_review_gate",
    description:
      "Internal workflow helper. Shapes the generate map's output into the reviewList UIBlock the review gate's STEP_UI entry renders via gateFromOutput.",
    inputSchema: { type: "object", properties: {} },
  };

function createPrepareReviewGateTool(): AgentTool {
  return {
    kind: "full",
    definition: MULTI_SOURCE_COLLATERAL_PREPARE_REVIEW_GATE_DEFINITION,
    handler: async (call) =>
      ok(
        call.id,
        buildReviewListBlock(
          coerceArgsValue(call.arguments),
          "Swipe Good / Bad on each draft. Rejected drafts are revised with feedback.",
        ),
      ),
  };
}

export const MULTI_SOURCE_COLLATERAL_PREPARE_REVIEW_FINAL_GATE_DEFINITION: ToolDefinition =
  {
    name: "multi_source_collateral_prepare_review_final_gate",
    description:
      "Internal workflow helper. Shapes the regenerate map's output into the reviewList UIBlock the review-final gate's STEP_UI entry renders via gateFromOutput.",
    inputSchema: { type: "object", properties: {} },
  };

function createPrepareReviewFinalGateTool(): AgentTool {
  return {
    kind: "full",
    definition: MULTI_SOURCE_COLLATERAL_PREPARE_REVIEW_FINAL_GATE_DEFINITION,
    handler: async (call) =>
      ok(
        call.id,
        buildReviewListBlock(
          coerceArgsValue(call.arguments),
          "Approve or discard the revised drafts.",
        ),
      ),
  };
}

// ---------------------------------------------------------------------------
// prepare-regenerate-items — fatal. Reads the review gate's decisions plus
// the ORIGINAL source context (identical for every piece, so no per-item
// context needs to be threaded back through the reviewList payload) and
// builds one regenerate payload per rejected piece.
// ---------------------------------------------------------------------------

const REGENERATE_FEEDBACK =
  "The reviewer rejected this draft. Produce a materially different, stronger take on the same content type and source material.";

export const MULTI_SOURCE_COLLATERAL_PREPARE_REGENERATE_ITEMS_DEFINITION: ToolDefinition =
  {
    name: "multi_source_collateral_prepare_regenerate_items",
    description:
      "Internal workflow helper. Builds one regenerate payload per rejected draft from the review gate's decisions and the original source context.",
    inputSchema: {
      type: "object",
      properties: {
        decisions: { type: "array", items: { type: "object" } },
        sourceContext: { type: "string" },
      },
    },
  };

function createPrepareRegenerateItemsTool(): AgentTool {
  return {
    kind: "full",
    definition: MULTI_SOURCE_COLLATERAL_PREPARE_REGENERATE_ITEMS_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const decisions = Array.isArray(args.decisions) ? args.decisions : [];
      const sourceContext =
        typeof args.sourceContext === "string" ? args.sourceContext : "";
      const rejected = decisions.filter(
        (decision): decision is Record<string, unknown> =>
          typeof decision === "object" &&
          decision !== null &&
          (decision as Record<string, unknown>).approved === false,
      );
      const regenerateItems = rejected.map((decision) => ({
        contentType: decision.format,
        format: decision.format,
        sourceContext,
        previousContent: decision.content,
        feedback: REGENERATE_FEEDBACK,
      }));
      return ok(call.id, {
        shouldRegenerate: regenerateItems.length > 0,
        regenerateItems,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// persist-pieces — fatal. Replaces the former per-piece `map`s (persist /
// persist-after-regen), folding the per-piece `artifact_create` fan-out into
// one tool for the same `map`-inner-step reason as fetch-sources above. One
// failed save fails the whole step, matching the originals' fatal semantics.
// ---------------------------------------------------------------------------

export const MULTI_SOURCE_COLLATERAL_PERSIST_PIECES_DEFINITION: ToolDefinition =
  {
    name: "multi_source_collateral_persist_pieces",
    description:
      "Internal workflow helper. Saves every approved piece as an artifact. Fatal — a failed save fails the run.",
    inputSchema: {
      type: "object",
      properties: {
        approvedPieces: { type: "array", items: { type: "object" } },
      },
    },
  };

function createPersistPiecesTool(env: Record<string, unknown>): AgentTool {
  return {
    kind: "full",
    definition: MULTI_SOURCE_COLLATERAL_PERSIST_PIECES_DEFINITION,
    handler: async (call, signal) => {
      const args = coerceArgsObject(call.arguments);
      const approvedPieces = Array.isArray(args.approvedPieces)
        ? args.approvedPieces
        : [];
      const runner = createArtifactRunner(env);
      const results: unknown[] = [];
      for (const piece of approvedPieces) {
        const record =
          typeof piece === "object" && piece !== null
            ? (piece as Record<string, unknown>)
            : {};
        const result = await runner.run(
          {
            id: `${call.id}-${String(results.length)}`,
            name: "artifact_create",
            arguments: {
              title: record.title,
              kind: record.format,
              content: record.content,
            },
          },
          signal,
        );
        if (result.isError === true) {
          return fail(
            call.id,
            `artifact_create failed for "${String(record.title)}": ${String(result.content)}`,
          );
        }
        results.push(result.content);
      }
      return ok(call.id, { artifacts: results });
    },
  };
}

/** Workflow-owned tools private to multi-source-collateral. `env` is the
 * sidecar-injected factory env, forwarded so fetch-sources/persist-pieces
 * can resolve their credentials lazily inside their own handlers. */
export function createMultiSourceCollateralTools(
  env: Record<string, unknown>,
): AgentTool[] {
  return [
    createListIssuesTool(env),
    createPrepareSourcesGateTool(),
    createFetchSourcesTool(env),
    createPrepareOptionsGateTool(),
    createBuildGenerateItemsTool(),
    createPrepareReviewGateTool(),
    createPrepareReviewFinalGateTool(),
    createPrepareRegenerateItemsTool(),
    createPersistPiecesTool(env),
  ];
}

// Env keys this factory needs injected. `linear`/`granola` are declared but
// resolved LAZILY inside their own handlers (fetch-sources, list-issues) —
// an unconfigured tenant degrades only the facet that needs that provider,
// never the whole tool package (`ToolCredentialMissingError` thrown eagerly
// at factory-construction time would drop artifact_list/create too).
export const MULTI_SOURCE_COLLATERAL_TOOLS_REQUIRES = [
  ...new Set([
    ...LIST_ISSUES_TOOL_REQUIRES,
    "workbench.cred.granola",
    "workbench.hubRpc",
  ]),
];
