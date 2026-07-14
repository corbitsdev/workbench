import { join } from "node:path";
import { type } from "arktype";
import { and, eq, sql } from "drizzle-orm";
import { getLogger } from "@intx/log";
import type { InferenceSource } from "@intx/types/runtime";
import { createIsogitStore } from "@workbench/storage-isogit";
import { artifact } from "../db/schema";
import type { HubDb } from "../db";
import { getConfig } from "../config";
import { runTrackedOneShot } from "./tracked-one-shot";
import type { GranolaCallFanout } from "./granola-call-fanout";

const log = getLogger(["services", "granola-call-pipeline"]);

/** The artifact kind one processed Granola call is persisted under. Its
 * `source` jsonb carries `{ granolaNoteId }`, which is what the pipeline's
 * per-call idempotency check keys on (a processed call already has its
 * artifact — the check survives restarts because it reads durable rows). */
export const GRANOLA_CALL_ARTIFACT_KIND = "granola-call";

/** The `artifact.source_ref` value for one Granola call, unique per tenant
 * (`artifact_tenant_source_ref_uniq`, migration 0055). This is the DB-level
 * backstop for the SELECT-then-INSERT race below: two concurrent
 * `processCall` runs for the same note can both pass `findExistingArtifactId`
 * and both run the LLM turn (that double-spend window is not closed by this
 * column — only a lock would close it), but only one of their inserts can
 * land; the loser's insert conflicts on this column and re-reads the
 * winner's row instead of creating a second artifact. */
function granolaCallSourceRef(noteId: string): string {
  return `granola:call:${noteId}`;
}

/** One participant/task actor: an assignee is matched to a member downstream
 * by email first, then unambiguous name (see the fan-out). */
export const CallActionSchema = type({
  description: "string",
  "assignee?": "string",
});
export type CallAction = typeof CallActionSchema.infer;

/** The reasoning turn's structured output (parsed at the LLM boundary). */
export const CallAnalysisSchema = type({
  summary: "string",
  painPoints: "string[]",
  decisions: "string[]",
  actionItems: CallActionSchema.array(),
  tasks: CallActionSchema.array(),
  peopleMentioned: "string[]",
});
export type CallAnalysis = typeof CallAnalysisSchema.infer;

/** A Granola call as the pipeline consumes it — the subset of a note the
 * pipeline reasons over. Parsed from the Granola tool response at the source
 * boundary before it reaches here. */
export const GranolaCallSchema = type({
  id: "string",
  "title?": "string | null",
  "summary?": "string",
  "participants?": "string[]",
  "createdAt?": "string",
  "transcript?": "string",
});
export type GranolaCall = typeof GranolaCallSchema.infer;

/** internal = every resolvable attendee shares the tenant domain; external =
 * at least one attendee is off-domain; unknown = no attendee email to judge. */
export type CallClassification = "internal" | "external" | "unknown";

export interface ProcessCallInput {
  tenantId: string;
  note: GranolaCall;
  signal?: AbortSignal;
}

export type ProcessCallResult =
  | { status: "processed"; artifactId: string; delivered: number }
  | { status: "skipped-duplicate" }
  | { status: "skipped-no-source" };

export interface GranolaCallPipeline {
  processCall(input: ProcessCallInput): Promise<ProcessCallResult>;
}

export interface GranolaCallPipelineDeps {
  db: HubDb;
  /** The domain every internal attendee shares (the root tenant's domain). */
  rootTenantDomain: string;
  /** Resolve the tenant's reasoning inference source (e.g. the Myra
   * definition's source). Returns null when none is configured — the call is
   * skipped legibly rather than stubbed. */
  resolveInferenceSource: (tenantId: string) => Promise<InferenceSource | null>;
  /** Delivers the per-recipient mail after the artifact is persisted. */
  fanout: GranolaCallFanout;
  /** Base dir for the per-call scratch store; defaults to the hub data dir. */
  dataDir?: string;
  now?: () => number;
}

const ANALYSIS_SYSTEM_PROMPT = `You analyze a sales/meeting call transcript and return STRICT JSON only (no prose, no code fences).

Return an object with these keys:
- "summary": a concise plain-text summary of the call (3-6 sentences).
- "painPoints": string[] — customer pain points / problems raised.
- "decisions": string[] — decisions made on the call.
- "actionItems": { "description": string, "assignee"?: string }[] — near-term action items. Set "assignee" to the person's name or email when the transcript makes it clear who owns it; omit otherwise.
- "tasks": { "description": string, "assignee"?: string }[] — concrete follow-up tasks (may overlap conceptually with action items but should be the trackable work).
- "peopleMentioned": string[] — names or emails of people discussed but not necessarily attendees.

Output ONLY the JSON object.`;

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (fenced?.[1] ?? trimmed).trim();
}

function emailDomain(participant: string): string | null {
  const at = participant.lastIndexOf("@");
  if (at < 0 || at === participant.length - 1) return null;
  return participant.slice(at + 1).toLowerCase();
}

/** Deterministic internal/external classification from attendee email domains
 * vs the tenant domain. No inference — a pure metadata rule. */
export function classifyCall(
  participants: readonly string[],
  tenantDomain: string,
): CallClassification {
  const domains = participants
    .map(emailDomain)
    .filter((d): d is string => d !== null);
  if (domains.length === 0) return "unknown";
  const domain = tenantDomain.toLowerCase();
  return domains.every((d) => d === domain) ? "internal" : "external";
}

function buildAnalysisMessage(note: GranolaCall): string {
  const parts = [
    `Title: ${note.title ?? "(untitled)"}`,
    note.participants && note.participants.length > 0
      ? `Attendees: ${note.participants.join(", ")}`
      : "Attendees: (unknown)",
    "",
    note.summary ? `Existing summary:\n${note.summary}` : "",
    note.transcript ? `Transcript:\n${note.transcript}` : "",
  ];
  return parts.filter((p) => p !== "").join("\n");
}

function renderArtifactContent(
  note: GranolaCall,
  classification: CallClassification,
  analysis: CallAnalysis,
): string {
  const bullets = (items: readonly string[]): string =>
    items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "- (none)";
  const actions = (items: readonly CallAction[]): string =>
    items.length > 0
      ? items
          .map(
            (i) =>
              `- ${i.description}${i.assignee ? ` (owner: ${i.assignee})` : ""}`,
          )
          .join("\n")
      : "- (none)";
  return [
    `# ${note.title ?? "Call"}`,
    "",
    `Classification: ${classification}`,
    note.participants && note.participants.length > 0
      ? `People: ${note.participants.join(", ")}`
      : "",
    "",
    "## Summary",
    analysis.summary,
    "",
    "## Pain points",
    bullets(analysis.painPoints),
    "",
    "## Decisions",
    bullets(analysis.decisions),
    "",
    "## Action items",
    actions(analysis.actionItems),
    "",
    "## Tasks",
    actions(analysis.tasks),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function findExistingArtifactId(
  db: HubDb,
  tenantId: string,
  noteId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: artifact.id })
    .from(artifact)
    .where(
      and(
        eq(artifact.tenantId, tenantId),
        eq(artifact.kind, GRANOLA_CALL_ARTIFACT_KIND),
        sql`${artifact.source}->>'granolaNoteId' = ${noteId}`,
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * The Granola call-processing pipeline (CL-3582). For one genuinely-new call:
 * classify internal/external deterministically, extract pain points / tasks /
 * action items / decisions and summarize via a single reasoning turn, persist
 * a call artifact, then hand off to the fan-out. Idempotent per call: an
 * already-persisted artifact for the note short-circuits with
 * `skipped-duplicate` (durable, so it holds across restarts).
 */
export function createGranolaCallPipeline(
  deps: GranolaCallPipelineDeps,
): GranolaCallPipeline {
  async function processCall(
    input: ProcessCallInput,
  ): Promise<ProcessCallResult> {
    const { tenantId, note } = input;

    const existing = await findExistingArtifactId(deps.db, tenantId, note.id);
    if (existing !== null) {
      log.info("granola call already processed; skipping {noteId}", {
        noteId: note.id,
        tenantId,
      });
      return { status: "skipped-duplicate" };
    }

    const source = await deps.resolveInferenceSource(tenantId);
    if (!source) {
      log.info("granola call: no inference source; skipping {noteId}", {
        noteId: note.id,
        tenantId,
      });
      return { status: "skipped-no-source" };
    }

    const participants = note.participants ?? [];
    const classification = classifyCall(participants, deps.rootTenantDomain);

    const baseDir = deps.dataDir ?? getConfig().hub.dataDir;
    const contextDir = join(baseDir, "granola-call", tenantId, note.id);
    const store = await createIsogitStore(contextDir);

    const raw = await runTrackedOneShot({
      db: deps.db,
      tenantId,
      source,
      systemPrompt: ANALYSIS_SYSTEM_PROMPT,
      agentIdPrefix: "granola-call",
      message: buildAnalysisMessage(note),
      store,
      workdir: contextDir,
      ...(input.signal ? { signal: input.signal } : {}),
    });

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripJsonFences(raw));
    } catch {
      throw new Error(
        `granola call ${note.id}: analysis turn returned non-JSON output`,
      );
    }
    const analysis = CallAnalysisSchema(parsedJson);
    if (analysis instanceof type.errors) {
      throw new Error(
        `granola call ${note.id}: analysis JSON failed validation: ${analysis.summary}`,
      );
    }

    const sourceRef = granolaCallSourceRef(note.id);
    const inserted = await deps.db
      .insert(artifact)
      .values({
        tenantId,
        kind: GRANOLA_CALL_ARTIFACT_KIND,
        title: note.title ?? "Call",
        content: renderArtifactContent(note, classification, analysis),
        sourceRef,
        source: {
          granolaNoteId: note.id,
          classification,
          participants,
          ...(note.createdAt ? { callCreatedAt: note.createdAt } : {}),
        },
      })
      .onConflictDoNothing({
        target: [artifact.tenantId, artifact.sourceRef],
        where: sql`${artifact.sourceRef} IS NOT NULL`,
      })
      .returning({ id: artifact.id });

    let artifactId: string;
    let alreadyProcessed: boolean;
    if (inserted[0]) {
      artifactId = inserted[0].id;
      alreadyProcessed = false;
    } else {
      // Lost the race: another insert for this noteId landed first. Re-read
      // the winner's row rather than creating a duplicate — the LLM turn
      // above was already spent for this attempt (that double-spend window
      // is not closeable without a lock; only the duplicate row is closed
      // here), but fan-out is skipped so the recipient never gets two mails
      // for one call.
      const winnerId = await findExistingArtifactId(deps.db, tenantId, note.id);
      if (winnerId === null) {
        throw new Error(
          `granola call ${note.id}: artifact insert conflicted but no existing row was found`,
        );
      }
      artifactId = winnerId;
      alreadyProcessed = true;
    }

    if (alreadyProcessed) {
      log.info("granola call lost the create race; skipping fan-out {noteId}", {
        noteId: note.id,
        tenantId,
      });
      return { status: "skipped-duplicate" };
    }

    const { delivered } = await deps.fanout.fanOut({
      tenantId,
      note,
      classification,
      analysis,
      artifactId,
    });

    return { status: "processed", artifactId, delivered };
  }

  return { processCall };
}
