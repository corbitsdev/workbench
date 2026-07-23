import { type } from "arktype";

// ---------------------------------------------------------------------------
// Workflow identity + hard caps (CL-3497 / CL-3708)
// ---------------------------------------------------------------------------

/** Catalog / schedule kind for the overnight prospect engine. */
export const PROSPECT_ENGINE_WORKFLOW_KIND = "prospect-engine";

export const PROSPECT_ENGINE_ARTIFACT_KIND_REPORT = "prospect-engine-report";
export const PROSPECT_ENGINE_ARTIFACT_KIND_LEDGER = "prospect-engine-ledger";

/** Stable title used by write_artifact upsert (principalId + title + kind). */
export const PROSPECT_ENGINE_LEDGER_ARTIFACT_TITLE =
  "Prospect engine — seen-accounts ledger";

/** Stable memory/artifact source key for the seen-accounts ledger. */
export const PROSPECT_ENGINE_LEDGER_SOURCE_KEY = "prospect-engine-ledger";

/** Hard Sumble credit cap per unattended run. */
export const PROSPECT_ENGINE_CREDIT_CAP = 800;

/** Wall-clock budget for one overnight run (ms). */
export const PROSPECT_ENGINE_WALL_CLOCK_MS = 45 * 60 * 1000;

/** Max email reveals per qualified account (10 credits each). */
export const PROSPECT_ENGINE_MAX_EMAIL_REVEALS_PER_ACCOUNT = 3;
/** @deprecated alias — prefer PROSPECT_ENGINE_MAX_EMAIL_REVEALS_PER_ACCOUNT */
export const PROSPECT_ENGINE_MAX_REVEALS_PER_ACCOUNT =
  PROSPECT_ENGINE_MAX_EMAIL_REVEALS_PER_ACCOUNT;

/** Wall-clock budget minutes (derived from ms constant). */
export const PROSPECT_ENGINE_RUNTIME_CAP_MINUTES = 45;

/** Target shortlist size band. */
export const PROSPECT_ENGINE_TARGET_MIN = 10;
export const PROSPECT_ENGINE_TARGET_MAX = 15;

/** Qualify threshold on the 0–100 rubric. */
export const PROSPECT_ENGINE_QUALIFY_SCORE = 60;

/** Slack digest warns when Sumble balance drops under this. */
export const PROSPECT_ENGINE_SLACK_BALANCE_WARN = 2000;

/**
 * Read-only Sumble org list: Attio open pipeline. Anything on this list is
 * never a prospect for the engine.
 */
export const PROSPECT_ENGINE_PIPELINE_LIST_ID = 80088;

/**
 * Engine lane list ids are tenant-specific (Joe / CL-3703). Until confirmed,
 * operators pass them on the schedule payload; shared code never hardcodes
 * placeholder ids that would write the wrong Sumble list.
 */
export const PROSPECT_ENGINE_GROWTH_LIST_NAME = "Engine - Growth";
export const PROSPECT_ENGINE_ENTERPRISE_LIST_NAME = "Engine - Enterprise";

/** Default Slack channel name (id still comes from schedule / CL-3717). */
export const PROSPECT_ENGINE_SLACK_CHANNEL_NAME = "prospect-engine";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ProspectEngineLaneSchema = type("'growth' | 'enterprise'");
export type ProspectEngineLane = typeof ProspectEngineLaneSchema.infer;

/**
 * Schedule / hub trigger payload after fire-time enrichment. List ids and
 * Slack channel are operator config (CL-3703 / CL-3717) until tenant constants
 * ship. `userAddress`/`userRefId`/`runDate`/`artifactTitle`/`runId` are
 * server-stamped — never trusted from the schedule row alone.
 */
export const ProspectEngineTriggerPayloadSchema = type({
  reason: "string > 0",
  userAddress: "string > 0",
  userRefId: "string > 0",
  runDate: "string > 0",
  artifactTitle: "string > 0",
  "slackChannelId?": "string > 0",
  growthEngineListId: "number.integer > 0",
  enterpriseEngineListId: "number.integer > 0",
  "runId?": "string > 0",
  "rampAIIndexInputs?": "string[]",
  "sumbleCreditBalance?": "number.integer >= 0",
});
export type ProspectEngineTriggerPayload =
  typeof ProspectEngineTriggerPayloadSchema.infer;

/**
 * Intake shape used by schedule UI / PATCH body. Required fields so a schedule
 * cannot be saved without Slack + both Engine list ids (CL-3703 / CL-3717).
 * Coerced to {@link ProspectEngineTriggerPayload} at fire time.
 */
export const ProspectEngineIntakePayloadSchema = type({
  "slackChannelId?": "string > 0",
  growthEngineListId: "string | number",
  enterpriseEngineListId: "string | number",
  "verticals?": "string[]",
});
export type ProspectEngineIntakePayload =
  typeof ProspectEngineIntakePayloadSchema.infer;

export type ProspectEngineMemberIdentity = {
  userAddress: string;
  userRefId: string;
};

/**
 * Coerce a schedule-stored list id (string from the intake form or number) into
 * a positive integer. Returns undefined when the value is missing/invalid so
 * the caller can fail closed rather than writing Sumble list 0.
 */
export function coercePositiveIntId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    const n = Number(trimmed);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return undefined;
}

/** Calendar date in America/New_York as YYYY-MM-DD (nightly digest stamp). */
export function prospectEngineRunDateEt(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

/**
 * Human-readable labels for the prospect-engine intake fields a run cannot
 * start without, keyed by the trigger-payload field name. Mirrors the labels
 * on the workflow's own `INTAKE_FIELDS` (Routine setup form) so a run-start
 * validation failure names the same thing the setup form asked for. Slack is
 * not listed here — it is an optional delivery destination, not a required
 * input; the digest always mails to the user's inbox.
 */
export const PROSPECT_ENGINE_REQUIRED_INTAKE_FIELD_LABELS: Record<
  string,
  string
> = {
  growthEngineListId: "Engine - Growth Sumble list id",
  enterpriseEngineListId: "Engine - Enterprise Sumble list id",
};

/**
 * The subset of the (post-enrichment) trigger payload that is genuinely
 * per-schedule input rather than server-stamped identity/date/title —
 * `enrichProspectEngineTriggerPayload` coerces `growthEngineListId` /
 * `enterpriseEngineListId` to positive integers and drops them from the
 * payload when the schedule never supplied a valid id, so their absence here
 * IS the "missing required input" signal a run-start check needs.
 * `slackChannelId` is intentionally not checked — it is optional; the digest
 * always mails to the user's inbox regardless of whether Slack is configured.
 */
export function findMissingProspectEngineIntakeFields(
  payload: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  if (
    typeof payload.growthEngineListId !== "number" ||
    !Number.isInteger(payload.growthEngineListId) ||
    payload.growthEngineListId <= 0
  ) {
    missing.push("growthEngineListId");
  }
  if (
    typeof payload.enterpriseEngineListId !== "number" ||
    !Number.isInteger(payload.enterpriseEngineListId) ||
    payload.enterpriseEngineListId <= 0
  ) {
    missing.push("enterpriseEngineListId");
  }
  return missing;
}

/**
 * Fire-time enrichment for prospect-engine starts (scheduler + manual). Stamps
 * identity, ET run date, artifact title, reason, and coerces list ids to numbers
 * so Sumble write tools receive integers.
 */
export function enrichProspectEngineTriggerPayload(
  triggerPayload: Record<string, unknown>,
  nowMs: number,
  memberIdentity: ProspectEngineMemberIdentity,
  lookback: "scheduled" | "manual-refresh" = "scheduled",
): Record<string, unknown> {
  const runDate = prospectEngineRunDateEt(nowMs);
  const growth = coercePositiveIntId(triggerPayload.growthEngineListId);
  const enterprise = coercePositiveIntId(triggerPayload.enterpriseEngineListId);
  const slackRaw = triggerPayload.slackChannelId;
  const slackChannelId =
    typeof slackRaw === "string" && slackRaw.trim().length > 0
      ? slackRaw.trim()
      : undefined;

  const enriched: Record<string, unknown> = {
    ...triggerPayload,
    reason:
      lookback === "manual-refresh"
        ? "manual-prospect-engine"
        : "scheduled-prospect-engine",
    userAddress: memberIdentity.userAddress,
    userRefId: memberIdentity.userRefId,
    runDate,
    artifactTitle: `Prospect engine — ${runDate}`,
  };
  delete enriched.slackChannelId;
  if (slackChannelId !== undefined) enriched.slackChannelId = slackChannelId;
  if (growth !== undefined) enriched.growthEngineListId = growth;
  if (enterprise !== undefined) enriched.enterpriseEngineListId = enterprise;
  return enriched;
}

export const ProspectEngineScoreBreakdownSchema = type({
  agentSurface: "0 <= number.integer <= 30",
  momentum: "0 <= number.integer <= 20",
  governanceNeed: "0 <= number.integer <= 20",
  laneFit: "0 <= number.integer <= 15",
  whyNow: "0 <= number.integer <= 15",
});
export type ProspectEngineScoreBreakdown =
  typeof ProspectEngineScoreBreakdownSchema.infer;

export const ProspectEngineContactSchema = type({
  name: "string",
  "title?": "string",
  "linkedinUrl?": "string",
  "email?": "string",
  "personId?": "number.integer > 0",
});
export type ProspectEngineContact = typeof ProspectEngineContactSchema.infer;

export const ProspectEngineCandidateSchema = type({
  organizationId: "number.integer > 0",
  "name?": "string",
  "domain?": "string",
  "slug?": "string",
  "lane?": ProspectEngineLaneSchema,
  "industry?": "string",
  "employeeCount?": "number.integer >= 0",
  "fundingRound?": "string",
  "fundingDate?": "string",
  "sumbleUrl?": "string",
  "evidence?": "string[]",
  "whyNow?": "string",
  "score?": "0 <= number.integer <= 100",
  "scoreBreakdown?": ProspectEngineScoreBreakdownSchema,
  "contacts?": ProspectEngineContactSchema.array(),
  "wedge?": "string",
});
export type ProspectEngineCandidate =
  typeof ProspectEngineCandidateSchema.infer;

export const ProspectEngineLedgerAccountSchema = type({
  organizationId: "number.integer > 0",
  "domain?": "string",
  "name?": "string",
  firstSeenRunDate: "string",
  lastSeenRunDate: "string",
  "lastScore?": "0 <= number.integer <= 100",
  "lane?": ProspectEngineLaneSchema,
  "status?": "'seen' | 'qualified' | 'recycled' | 'killed'",
  "recycleSignal?": "string",
});
export type ProspectEngineLedgerAccount =
  typeof ProspectEngineLedgerAccountSchema.infer;

export const ProspectEngineCreditLogEntrySchema = type({
  runDate: "string",
  used: "number.integer >= 0",
  "stopReason?": "string",
  "remainingBalance?": "number.integer >= 0",
});
export type ProspectEngineCreditLogEntry =
  typeof ProspectEngineCreditLogEntrySchema.infer;

export const ProspectEngineLedgerSchema = type({
  version: "number.integer >= 1",
  accounts: ProspectEngineLedgerAccountSchema.array(),
  creditLog: ProspectEngineCreditLogEntrySchema.array(),
  "rubricNotes?": "string",
  updatedAt: "string",
});
export type ProspectEngineLedger = typeof ProspectEngineLedgerSchema.infer;

export const ProspectEngineCreditBudgetSchema = type({
  used: "number.integer >= 0",
  cap: "number.integer > 0",
  remaining: "number.integer >= 0",
  startedAtMs: "number.integer > 0",
  wallClockMs: "number.integer > 0",
  "stopReason?": "string",
});
export type ProspectEngineCreditBudget =
  typeof ProspectEngineCreditBudgetSchema.infer;

export const ProspectEngineNightlySourceMetadataSchema = type({
  runDate: "string",
  workflowKind: "string",
  "stopReason?": "string",
  creditsUsed: "number.integer >= 0",
  "sumbleCreditBalance?": "number.integer >= 0",
  growthCount: "number.integer >= 0",
  enterpriseCount: "number.integer >= 0",
});
export type ProspectEngineNightlySourceMetadata =
  typeof ProspectEngineNightlySourceMetadataSchema.infer;

// ---------------------------------------------------------------------------
// Pure domain helpers
// ---------------------------------------------------------------------------

export function emptyProspectEngineLedger(
  nowIso = new Date().toISOString(),
): ProspectEngineLedger {
  return {
    version: 1,
    accounts: [],
    creditLog: [],
    updatedAt: nowIso,
  };
}

/**
 * Parse ledger JSON from memory/artifact content. Invalid or empty content
 * returns a fresh ledger (first-run path).
 */
export function parseProspectEngineLedger(
  content: unknown,
): ProspectEngineLedger {
  if (content === null || content === undefined) {
    return emptyProspectEngineLedger();
  }
  let raw: unknown = content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.length === 0) return emptyProspectEngineLedger();
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return emptyProspectEngineLedger();
    }
  }
  const validated = ProspectEngineLedgerSchema(raw);
  if (validated instanceof type.errors) {
    return emptyProspectEngineLedger();
  }
  return validated;
}

export function orgKey(organizationId: number): string {
  return String(organizationId);
}

export function ledgerOrgIdSet(ledger: ProspectEngineLedger): Set<number> {
  return new Set(ledger.accounts.map((a) => a.organizationId));
}

export function extractOrganizationIds(value: unknown): number[] {
  const ids = new Set<number>();
  collectOrgIds(value, ids);
  return [...ids];
}

function collectOrgIds(value: unknown, out: Set<number>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    out.add(value);
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    // Numeric id string
    const n = Number(trimmed);
    if (Number.isInteger(n) && n > 0 && String(n) === trimmed) {
      out.add(n);
      return;
    }
    // String-tool / artifact payloads often JSON-encode the real structure
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        collectOrgIds(JSON.parse(trimmed), out);
      } catch {
        /* not JSON */
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectOrgIds(item, out);
    return;
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const key of [
      "organizationId",
      "organization_id",
      "id",
      "orgId",
    ] as const) {
      const v = rec[key];
      if (typeof v === "number" && Number.isInteger(v) && v > 0) {
        out.add(v);
      }
    }
    for (const v of Object.values(rec)) collectOrgIds(v, out);
  }
}

/**
 * Drop candidates already on the ledger, pipeline list, or either Engine list.
 * Recycled ledger accounts with a new signal stay only when `allowRecycle` is set
 * on the candidate (optional future path); v1 defaults to hard exclude.
 */
export function dedupeProspectCandidates(input: {
  candidates: ProspectEngineCandidate[];
  ledger: ProspectEngineLedger;
  pipelineOrgIds: number[];
  growthOrgIds: number[];
  enterpriseOrgIds: number[];
}): {
  kept: ProspectEngineCandidate[];
  removed: { organizationId: number; reason: string }[];
} {
  const blocked = new Map<number, string>();
  for (const id of input.ledger.accounts.map((a) => a.organizationId)) {
    blocked.set(id, "ledger");
  }
  for (const id of input.pipelineOrgIds) blocked.set(id, "pipeline");
  for (const id of input.growthOrgIds) blocked.set(id, "engine-growth");
  for (const id of input.enterpriseOrgIds) blocked.set(id, "engine-enterprise");

  const kept: ProspectEngineCandidate[] = [];
  const removed: { organizationId: number; reason: string }[] = [];
  const seen = new Set<number>();

  for (const c of input.candidates) {
    if (seen.has(c.organizationId)) {
      removed.push({ organizationId: c.organizationId, reason: "duplicate" });
      continue;
    }
    seen.add(c.organizationId);
    const reason = blocked.get(c.organizationId);
    if (reason !== undefined) {
      removed.push({ organizationId: c.organizationId, reason });
      continue;
    }
    kept.push(c);
  }
  return { kept, removed };
}

export function initProspectEngineCreditBudget(
  nowMs = Date.now(),
  cap = PROSPECT_ENGINE_CREDIT_CAP,
  wallClockMs = PROSPECT_ENGINE_WALL_CLOCK_MS,
): ProspectEngineCreditBudget {
  return {
    used: 0,
    cap,
    remaining: cap,
    startedAtMs: nowMs,
    wallClockMs,
  };
}

/**
 * Fail-closed charge. Returns updated budget, or the same budget with
 * stopReason set and no charge applied when the cap or wall clock is hit.
 */
export function chargeProspectEngineCredits(
  budget: ProspectEngineCreditBudget,
  amount: number,
  nowMs = Date.now(),
): {
  budget: ProspectEngineCreditBudget;
  charged: boolean;
  stopReason?: string;
} {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("charge amount must be a non-negative number");
  }
  if (budget.stopReason) {
    return { budget, charged: false, stopReason: budget.stopReason };
  }
  if (nowMs - budget.startedAtMs >= budget.wallClockMs) {
    const next = {
      ...budget,
      stopReason: "wall-clock",
    };
    return { budget: next, charged: false, stopReason: "wall-clock" };
  }
  if (budget.used + amount > budget.cap) {
    const next = {
      ...budget,
      stopReason: "credit-cap",
    };
    return { budget: next, charged: false, stopReason: "credit-cap" };
  }
  const used = budget.used + amount;
  const next = {
    ...budget,
    used,
    remaining: budget.cap - used,
  };
  return { budget: next, charged: true };
}

/**
 * Merge tonight's qualified accounts into the ledger. Growth is O(unique orgs):
 * existing org keys are updated in place, not appended as nightly duplicates.
 */
export function mergeProspectEngineLedger(input: {
  ledger: ProspectEngineLedger;
  runDate: string;
  accounts: Array<{
    organizationId: number;
    name?: string;
    domain?: string;
    lane?: ProspectEngineLane;
    score?: number;
    status?: ProspectEngineLedgerAccount["status"];
    recycleSignal?: string;
  }>;
  creditsUsed: number;
  stopReason?: string;
  remainingBalance?: number;
  nowIso?: string;
}): ProspectEngineLedger {
  const byId = new Map(
    input.ledger.accounts.map((a) => [a.organizationId, { ...a }] as const),
  );

  for (const next of input.accounts) {
    const prev = byId.get(next.organizationId);
    if (prev === undefined) {
      const created: ProspectEngineLedgerAccount = {
        organizationId: next.organizationId,
        firstSeenRunDate: input.runDate,
        lastSeenRunDate: input.runDate,
        status: next.status ?? "seen",
      };
      if (next.name !== undefined) created.name = next.name;
      if (next.domain !== undefined) created.domain = next.domain;
      if (next.score !== undefined) created.lastScore = next.score;
      if (next.lane !== undefined) created.lane = next.lane;
      if (next.recycleSignal !== undefined) {
        created.recycleSignal = next.recycleSignal;
      }
      byId.set(next.organizationId, created);
      continue;
    }
    const status = next.status ?? prev.status ?? "seen";
    const updated: ProspectEngineLedgerAccount = {
      organizationId: prev.organizationId,
      firstSeenRunDate: prev.firstSeenRunDate,
      lastSeenRunDate: input.runDate,
      status,
    };
    const name = next.name ?? prev.name;
    if (name !== undefined) updated.name = name;
    const domain = next.domain ?? prev.domain;
    if (domain !== undefined) updated.domain = domain;
    const lastScore = next.score ?? prev.lastScore;
    if (lastScore !== undefined) updated.lastScore = lastScore;
    const lane = next.lane ?? prev.lane;
    if (lane !== undefined) updated.lane = lane;
    const recycleSignal = next.recycleSignal ?? prev.recycleSignal;
    if (recycleSignal !== undefined) updated.recycleSignal = recycleSignal;
    byId.set(next.organizationId, updated);
  }

  const creditEntry: ProspectEngineCreditLogEntry = {
    runDate: input.runDate,
    used: input.creditsUsed,
  };
  if (input.stopReason !== undefined) creditEntry.stopReason = input.stopReason;
  if (input.remainingBalance !== undefined) {
    creditEntry.remainingBalance = input.remainingBalance;
  }

  const creditLog = [...input.ledger.creditLog, creditEntry];

  // Keep credit log bounded (last 90 nights) so memory stays small.
  const trimmedLog =
    creditLog.length > 90 ? creditLog.slice(creditLog.length - 90) : creditLog;

  const result: ProspectEngineLedger = {
    version: input.ledger.version,
    accounts: [...byId.values()].sort(
      (a, b) => a.organizationId - b.organizationId,
    ),
    creditLog: trimmedLog,
    updatedAt: input.nowIso ?? new Date().toISOString(),
  };
  if (input.ledger.rubricNotes !== undefined) {
    result.rubricNotes = input.ledger.rubricNotes;
  }
  return result;
}

export function scoreTotal(breakdown: ProspectEngineScoreBreakdown): number {
  return (
    breakdown.agentSurface +
    breakdown.momentum +
    breakdown.governanceNeed +
    breakdown.laneFit +
    breakdown.whyNow
  );
}

export function qualifyProspects(
  candidates: ProspectEngineCandidate[],
  minScore = PROSPECT_ENGINE_QUALIFY_SCORE,
  maxKeep = PROSPECT_ENGINE_TARGET_MAX,
): ProspectEngineCandidate[] {
  return [...candidates]
    .filter((c) => (c.score ?? 0) >= minScore)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, maxKeep);
}

/** Drop phone fields — v1 never reveals phones (80 credits each). */
export function sanitizeProspectEngineContacts(
  contacts: ProspectEngineContact[] | undefined,
): ProspectEngineContact[] | undefined {
  if (contacts === undefined) return undefined;
  return contacts.map((c) => {
    const next: ProspectEngineContact = { name: c.name };
    if (c.title !== undefined) next.title = c.title;
    if (c.linkedinUrl !== undefined) next.linkedinUrl = c.linkedinUrl;
    if (c.email !== undefined) next.email = c.email;
    if (c.personId !== undefined) next.personId = c.personId;
    return next;
  });
}

/**
 * Merge map/reveal enrichments onto the qualified shortlist.
 * Base order and membership win so delivery never depends solely on the
 * map agent emitting a complete accounts array. Overlay-only orgs are dropped.
 */
export function mergeProspectEngineShortlist(
  base: ProspectEngineCandidate[],
  overlay: ProspectEngineCandidate[],
): ProspectEngineCandidate[] {
  const overById = new Map(overlay.map((a) => [a.organizationId, a]));
  return base.map((b) => {
    const o = overById.get(b.organizationId);
    if (!o) {
      return {
        ...b,
        contacts: sanitizeProspectEngineContacts(b.contacts),
      };
    }
    const contacts =
      sanitizeProspectEngineContacts(o.contacts) ??
      sanitizeProspectEngineContacts(b.contacts);
    return {
      ...b,
      ...o,
      organizationId: b.organizationId,
      // Prefer overlay enrichments, fall back to base for missing fields
      name: o.name ?? b.name,
      domain: o.domain ?? b.domain,
      lane: o.lane ?? b.lane,
      score: o.score ?? b.score,
      scoreBreakdown: o.scoreBreakdown ?? b.scoreBreakdown,
      whyNow: o.whyNow ?? b.whyNow,
      wedge: o.wedge ?? b.wedge,
      sumbleUrl: o.sumbleUrl ?? b.sumbleUrl,
      evidence: o.evidence ?? b.evidence,
      industry: o.industry ?? b.industry,
      ...(contacts !== undefined ? { contacts } : {}),
    };
  });
}

export function buildProspectEngineReportMarkdown(input: {
  runDate: string;
  accounts: ProspectEngineCandidate[];
  creditsUsed: number;
  stopReason?: string;
  thinNight?: boolean;
}): string {
  const lines: string[] = [
    `# Prospect engine — ${input.runDate}`,
    "",
    input.thinNight
      ? `_Thin night: fewer than 5 qualified accounts._`
      : `_${input.accounts.length} qualified accounts._`,
    "",
    `| # | Account | Lane | Score | Domain | Why now | Wedge | Sumble |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];

  input.accounts.forEach((a, i) => {
    const name = a.name ?? `org ${a.organizationId}`;
    const lane = a.lane ?? "";
    const score = a.score ?? "";
    const domain = a.domain ?? "";
    const why = (a.whyNow ?? "").replace(/\|/g, "/");
    const wedge = (a.wedge ?? "").replace(/\|/g, "/");
    const url = a.sumbleUrl ?? "";
    lines.push(
      `| ${i + 1} | ${name} | ${lane} | ${score} | ${domain} | ${why} | ${wedge} | ${url} |`,
    );
  });

  lines.push("", `Credits used: ${input.creditsUsed}`);
  if (input.stopReason) {
    lines.push(`Stop reason: ${input.stopReason}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function buildProspectEngineReportCsv(
  accounts: ProspectEngineCandidate[],
): string {
  const header = [
    "organizationId",
    "name",
    "domain",
    "lane",
    "score",
    "agentSurface",
    "momentum",
    "governanceNeed",
    "laneFit",
    "whyNowScore",
    "whyNow",
    "wedge",
    "contacts",
    "sumbleUrl",
  ];
  const rows = accounts.map((a) => {
    const b = a.scoreBreakdown;
    const contacts = (a.contacts ?? [])
      .map((c) => {
        const bits = [c.name, c.title, c.email, c.linkedinUrl].filter(Boolean);
        return bits.join(" / ");
      })
      .join("; ");
    return [
      a.organizationId,
      csvEscape(a.name ?? ""),
      csvEscape(a.domain ?? ""),
      a.lane ?? "",
      a.score ?? "",
      b?.agentSurface ?? "",
      b?.momentum ?? "",
      b?.governanceNeed ?? "",
      b?.laneFit ?? "",
      b?.whyNow ?? "",
      csvEscape(a.whyNow ?? ""),
      csvEscape(a.wedge ?? ""),
      csvEscape(contacts),
      csvEscape(a.sumbleUrl ?? ""),
    ].join(",");
  });
  return [header.join(","), ...rows].join("\n");
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function formatProspectEngineSlackDigest(input: {
  runDate: string;
  accounts: ProspectEngineCandidate[];
  creditsUsed: number;
  remainingBudget: number;
  sumbleCreditBalance?: number;
  stopReason?: string;
  artifactId?: string;
  runId?: string;
}): string {
  const growth = input.accounts.filter((a) => a.lane === "growth").length;
  const enterprise = input.accounts.filter(
    (a) => a.lane === "enterprise",
  ).length;
  const thin = input.accounts.length < 5;

  const lines: string[] = [
    `prospect engine — ${input.runDate}`,
    thin
      ? `thin night: ${input.accounts.length} qualified (not padding)`
      : `${input.accounts.length} qualified · growth ${growth} · enterprise ${enterprise}`,
    `credits: ${input.creditsUsed} used · ${input.remainingBudget} budget left`,
  ];

  if (input.sumbleCreditBalance !== undefined) {
    lines.push(`sumble balance: ${input.sumbleCreditBalance}`);
    if (input.sumbleCreditBalance < PROSPECT_ENGINE_SLACK_BALANCE_WARN) {
      lines.push(
        `⚠ sumble balance under ${PROSPECT_ENGINE_SLACK_BALANCE_WARN} — top up soon`,
      );
    }
  }
  if (input.stopReason) {
    lines.push(`stopped early: ${input.stopReason}`);
  }

  lines.push("", "top accounts:");
  const top = input.accounts.slice(0, 5);
  if (top.length === 0) {
    lines.push("· none tonight");
  } else {
    for (const a of top) {
      const name = a.name ?? `org ${a.organizationId}`;
      const wedge = a.wedge ?? a.whyNow ?? "no wedge";
      lines.push(`· ${name} (${a.score ?? "?"}) — ${wedge}`);
    }
  }

  if (input.artifactId) {
    lines.push("", `artifact: ${input.artifactId}`);
  }
  if (input.runId) {
    lines.push(`run: ${input.runId}`);
  }

  return lines.join("\n");
}

export function prospectEngineMailRefs(
  artifactId: string,
  runId: string,
  workflowLabel = "Prospect engine",
): Array<{ kind: "artifact" | "workflow_run"; ref: string; label: string }> {
  const id = artifactId.trim();
  if (id.length === 0) {
    throw new Error("artifactId is required for prospect engine mail refs");
  }
  const run = runId.trim();
  if (run.length === 0) {
    throw new Error("runId is required for prospect engine mail refs");
  }
  const label = workflowLabel.trim() || "run";
  return [
    { kind: "artifact", ref: id, label: "Open prospect list" },
    { kind: "workflow_run", ref: run, label: `Open ${label}` },
  ];
}

/** Tools the prospect-engine discover agent must never receive. */
export const PROSPECT_ENGINE_DISCOVER_FORBIDDEN_TOOLS = [
  "slack_post_message",
  "mail_send",
  "write_artifact",
  "memory_save",
  "sumble_add_organization_list_organizations",
  "sumble_add_contact_list_contacts",
  "sumble_create_organization_list",
  "sumble_create_contact_list",
] as const;

/** Deterministic write tools allowed on the delivery path only. */
export const PROSPECT_ENGINE_ALLOWED_WRITE_TOOLS = [
  "write_artifact",
  "sumble_add_organization_list_organizations",
  "slack_post_message",
  "mail_send",
] as const;
