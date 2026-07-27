// Workflow-owned copies of the small, pure helpers heartbeat needs to
// generate its step graph, format the brief's title/document/notify shapes,
// and parse a tolerant intake step's degrade envelope. Formerly imported
// from `@workbench/shared` — duplicated here deliberately so this workflow
// package carries no framework/shared dependency. Any drift from the
// `@workbench/shared` originals (`preferences-registry.ts`,
// `heartbeat-brief-title.ts`, `heartbeat-brief-document.ts`,
// `heartbeat-brief-mail-refs.ts`, `heartbeat-brief-merge.ts`,
// `tolerance-envelope.ts`) is acceptable — this workflow is self-contained.

/** The minimal shape heartbeat needs per wired brief source. */
export interface BriefSourceDescriptor {
  key: string;
  label: string;
  tool: string;
}

/**
 * The brief sources heartbeat generates one intake step per. Static rather
 * than derived from a shared credential-provider catalog — adding a fifth
 * source means adding a row here, a `SOURCE_TOOL_BUILDERS` entry in
 * `tools.ts`, a `SOURCE_TOOL_HANDLERS` entry in `index.ts`, and the matching
 * expected sibling in `index.test.ts`.
 */
export const WIRED_BRIEF_SOURCES: readonly BriefSourceDescriptor[] = [
  { key: "granola", label: "Granola", tool: "granola_list_notes" },
  { key: "linear", label: "Linear", tool: "linear_list_issues" },
  { key: "attio", label: "Attio", tool: "attio_recent_activity" },
  { key: "vercel", label: "Vercel", tool: "vercel_list_deployments" },
];

/** The heartbeat intake step key generated for a wired brief source. */
export function heartbeatIntakeStepKey(sourceKey: string): string {
  return `intake-${sourceKey}`;
}

const MORNING_BRIEF_KIND = "morning-brief";

/** Stable artifact `kind` for every persisted morning brief — never "report". */
export function morningBriefArtifactKind(): string {
  return MORNING_BRIEF_KIND;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Formats a UTC instant as DD/MM/YY. */
export function formatBriefDateDdMmYy(nowMs: number): string {
  const d = new Date(nowMs);
  const day = pad2(d.getUTCDate());
  const month = pad2(d.getUTCMonth() + 1);
  const year = pad2(d.getUTCFullYear() % 100);
  return `${day}/${month}/${year}`;
}

/**
 * Builds the morning brief's display name: `<User>'s Morning Brief - DD/MM/YY`.
 * Falls back to "Your Morning Brief - DD/MM/YY" when no display name is known
 * for the firing user.
 */
export function formatHeartbeatBriefTitle(
  userDisplayName: string | undefined,
  nowMs: number,
): string {
  const datePart = formatBriefDateDdMmYy(nowMs);
  const name = userDisplayName?.trim();
  const possessive = name && name.length > 0 ? `${name}'s` : "Your";
  return `${possessive} Morning Brief - ${datePart}`;
}

/**
 * Composes the morning brief's persisted document from the title step's
 * `title` and the brief agent's `reply` — the single place that turns the
 * agent-`reply` output field into the `body` name `write_artifact` accepts.
 */
export function formatHeartbeatBriefDocument(
  title: string,
  reply: string,
): { title: string; body: string } {
  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0) {
    throw new Error("title is required to compose the brief document");
  }
  if (reply.trim().length === 0) {
    throw new Error("reply is required to compose the brief document");
  }
  return { title: trimmedTitle, body: reply };
}

/** A related-row ref for the notify mail's "Related" action row. */
export interface HeartbeatMailRef {
  kind: "artifact" | "workflow_run";
  ref: string;
  label: string;
}

/** Related-row refs for a morning-brief notify mail after persist. */
export function morningBriefMailRefs(
  artifactId: string,
  runId: string,
  workflowLabel = "Company Heartbeat",
): HeartbeatMailRef[] {
  const id = artifactId.trim();
  if (id.length === 0) {
    throw new Error("artifactId is required for morning brief mail refs");
  }
  const run = runId.trim();
  if (run.length === 0) {
    throw new Error("runId is required for morning brief mail refs");
  }
  const label = workflowLabel.trim() || "run";
  return [
    { kind: "artifact", ref: id, label: "Open brief" },
    { kind: "workflow_run", ref: run, label: `Open ${label}` },
  ];
}

/**
 * Composes the morning-brief notify mail's exact `mail_send` argument shape:
 * `{ to, subject, content, refs }`.
 */
export function morningBriefNotifyMail(params: {
  userAddress: string;
  title: string;
  body: string;
  artifactId: string;
  runId: string;
  workflowLabel?: string;
}): { to: string; subject: string; content: string; refs: HeartbeatMailRef[] } {
  const to = params.userAddress.trim();
  if (to.length === 0) {
    throw new Error("userAddress is required for the morning brief mail");
  }
  const subject = params.title.trim();
  if (subject.length === 0) {
    throw new Error("title is required for the morning brief mail subject");
  }
  const refs = morningBriefMailRefs(
    params.artifactId,
    params.runId,
    params.workflowLabel,
  );
  return { to, subject, content: params.body, refs };
}

// ---------------------------------------------------------------------------
// The tolerance envelope — the one degrade shape every best-effort wrapper in
// this workflow uses: failure is `{ isError: true, error }` carried INSIDE a
// completed tool's `content`, never the outer `ToolResult.isError`.
// ---------------------------------------------------------------------------

export interface ToleranceEnvelopeFailure {
  isError: true;
  error: string;
  [key: string]: unknown;
}

/** Build the canonical failure `content` value a tolerant wrapper embeds. */
export function toleranceFailureContent(
  error: string,
): ToleranceEnvelopeFailure {
  return { isError: true, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToleranceEnvelopeFailure(
  value: unknown,
): value is ToleranceEnvelopeFailure {
  return (
    isRecord(value) && value.isError === true && typeof value.error === "string"
  );
}

export type ToleranceEnvelopeParse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * Parse a tolerant wrapper's stored `content` into `{ ok, data }` /
 * `{ ok: false, error }`. Handles a plain `{ isError: true, error }` object,
 * that same object JSON-stringified, a bare successful JSON payload, or a
 * bare non-JSON success string.
 */
export function parseToleranceEnvelope(
  content: unknown,
): ToleranceEnvelopeParse {
  let value: unknown = content;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return { ok: true, data: undefined };
    }
    try {
      value = JSON.parse(trimmed);
    } catch {
      return { ok: true, data: content };
    }
  }
  if (isToleranceEnvelopeFailure(value)) {
    return { ok: false, error: value.error };
  }
  return { ok: true, data: value };
}

/**
 * Parse one intake step's stored tool envelope into source-shaped JSON for
 * the brief. Two wire shapes reach here: a plain-text outer `isError: true`
 * (handled below before delegating to `parseToleranceEnvelope`), and the
 * native-action shape every real `heartbeat_intake_source` step produces —
 * outer `isError` always false, a failure nested in `content` as
 * `{ isError: true, error }`.
 */
export function parseBriefSourceToolEnvelope(
  stepOutput: unknown,
): Record<string, unknown> {
  if (!isRecord(stepOutput)) {
    return { skipped: true, reason: "missing intake output" };
  }
  if (stepOutput.isError === true) {
    const raw = stepOutput.content;
    if (typeof raw === "string" && raw.length > 0) {
      return toleranceFailureContent(raw);
    }
    if (isRecord(raw) && typeof raw.error === "string") {
      return toleranceFailureContent(raw.error);
    }
    return toleranceFailureContent("source unavailable");
  }
  const parsed = parseToleranceEnvelope(stepOutput.content);
  if (!parsed.ok) {
    return toleranceFailureContent(parsed.error);
  }
  if (parsed.data === undefined) {
    return {};
  }
  if (isRecord(parsed.data)) {
    return parsed.data;
  }
  return toleranceFailureContent("non-object JSON in tool content");
}

/**
 * Build `{ sources: { granola, linear, attio, vercel } }` from projected
 * intake step records (`{ output: toolEnvelope }` per `steps.intake-<source>`).
 */
export function mergeHeartbeatBriefSources(
  projectedSteps: Record<string, unknown>,
): { sources: Record<string, Record<string, unknown>> } {
  const sources: Record<string, Record<string, unknown>> = {};
  for (const source of WIRED_BRIEF_SOURCES) {
    const stepId = heartbeatIntakeStepKey(source.key);
    const entry = projectedSteps[stepId];
    const output =
      isRecord(entry) && "output" in entry ? entry.output : undefined;
    sources[source.key] = parseBriefSourceToolEnvelope(output);
  }
  return { sources };
}
