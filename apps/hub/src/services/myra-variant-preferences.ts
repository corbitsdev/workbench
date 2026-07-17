import { and, eq } from "drizzle-orm";
import { type } from "arktype";
import {
  isMyraVariantId,
  isStyleAxisOptionId,
  MAX_PINNED_MYRA_SKILLS,
} from "@workbench/myra";
import { listSkills, type SkillViewer } from "./skill-library";
import { myraVariantPreference } from "../db/schema";
import type { HubDb } from "../db";

/**
 * Max length of a single standing-instructions field (global or per-surface
 * override), enforced at the API boundary via the arktype patch schema.
 */
export const MYRA_INSTRUCTIONS_MAX_LENGTH = 4000;

/**
 * A member's stored default-variant selection, standing guidance, and
 * personalization-style selection. `null` on the variant axes means "use the
 * canonical default"; `null`/absent on the instructions axes means "nothing
 * set"; `null` on a style axis means "use the axis's default option" — the
 * byte-identical current behavior. This is the read shape returned by GET
 * and PUT. Style axes: `personality` / `emojiUse` / `uiType` are global
 * (shared by chat and triage); the three usage dials are per-surface.
 */
export const MyraVariantPreferenceSchema = type({
  chat: "string | null",
  triage: "string | null",
  instructionsGlobal: "string | null",
  instructionsChat: "string | null",
  instructionsTriage: "string | null",
  personality: "string | null",
  emojiUse: "string | null",
  uiType: "string | null",
  artifactUsageChat: "string | null",
  artifactUsageTriage: "string | null",
  toolUsageChat: "string | null",
  toolUsageTriage: "string | null",
  skillUsageChat: "string | null",
  skillUsageTriage: "string | null",
  pinnedSkillIds: "string[]",
  disabledCatalogPackages: "string[]",
  disabledToolNames: "string[]",
  creativeChat: "number | null",
  thinkingChat: "number | null",
  creativeTriage: "number | null",
  thinkingTriage: "number | null",
});
export type MyraVariantPreference = typeof MyraVariantPreferenceSchema.infer;

export const MyraToolCatalogEntrySchema = type({
  package: "string",
  description: "string",
  tools: type({ name: "string", description: "string" }).array(),
});

export const MyraMemberPreferencesResponseSchema =
  MyraVariantPreferenceSchema.and({
    toolCatalog: MyraToolCatalogEntrySchema.array(),
  });
export type MyraMemberPreferencesResponse =
  typeof MyraMemberPreferencesResponseSchema.infer;

const InstructionsFieldSchema = type(
  `string <= ${MYRA_INSTRUCTIONS_MAX_LENGTH} | null`,
);

const InferenceDialFieldSchema = type("0 <= number <= 100 | null");

/**
 * The PUT patch: every field may be omitted (left untouched), set to a value,
 * or set to `null` (cleared). Instructions fields are length-capped at
 * {@link MYRA_INSTRUCTIONS_MAX_LENGTH} characters; style-axis fields clear
 * back to that axis's default option.
 */
export const MyraVariantPreferencePatchSchema = type({
  "chat?": "string | null",
  "triage?": "string | null",
  "instructionsGlobal?": InstructionsFieldSchema,
  "instructionsChat?": InstructionsFieldSchema,
  "instructionsTriage?": InstructionsFieldSchema,
  "personality?": "string | null",
  "emojiUse?": "string | null",
  "uiType?": "string | null",
  "artifactUsageChat?": "string | null",
  "artifactUsageTriage?": "string | null",
  "toolUsageChat?": "string | null",
  "toolUsageTriage?": "string | null",
  "skillUsageChat?": "string | null",
  "skillUsageTriage?": "string | null",
  "pinnedSkillIds?": "string[]",
  "disabledCatalogPackages?": "string[]",
  "disabledToolNames?": "string[]",
  "creativeChat?": InferenceDialFieldSchema,
  "thinkingChat?": InferenceDialFieldSchema,
  "creativeTriage?": InferenceDialFieldSchema,
  "thinkingTriage?": InferenceDialFieldSchema,
});
export type MyraVariantPreferencePatch =
  typeof MyraVariantPreferencePatchSchema.infer;

const EMPTY_PREFERENCE: MyraVariantPreference = {
  chat: null,
  triage: null,
  instructionsGlobal: null,
  instructionsChat: null,
  instructionsTriage: null,
  personality: null,
  emojiUse: null,
  uiType: null,
  artifactUsageChat: null,
  artifactUsageTriage: null,
  toolUsageChat: null,
  toolUsageTriage: null,
  skillUsageChat: null,
  skillUsageTriage: null,
  pinnedSkillIds: [],
  disabledCatalogPackages: [],
  disabledToolNames: [],
  creativeChat: null,
  thinkingChat: null,
  creativeTriage: null,
  thinkingTriage: null,
};

export async function readMyraVariantPreference(
  db: HubDb,
  tenantId: string,
  memberPrincipalId: string,
): Promise<MyraVariantPreference> {
  const row = await db.query.myraVariantPreference.findFirst({
    where: and(
      eq(myraVariantPreference.tenantId, tenantId),
      eq(myraVariantPreference.memberPrincipalId, memberPrincipalId),
    ),
  });
  if (!row) return { ...EMPTY_PREFERENCE };
  return {
    chat: row.chatVariantId,
    triage: row.triageVariantId,
    instructionsGlobal: row.instructionsGlobal ?? null,
    instructionsChat: row.instructionsChat ?? null,
    instructionsTriage: row.instructionsTriage ?? null,
    personality: row.personality ?? null,
    emojiUse: row.emojiUse ?? null,
    uiType: row.uiType ?? null,
    artifactUsageChat: row.artifactUsageChat ?? null,
    artifactUsageTriage: row.artifactUsageTriage ?? null,
    toolUsageChat: row.toolUsageChat ?? null,
    toolUsageTriage: row.toolUsageTriage ?? null,
    skillUsageChat: row.skillUsageChat ?? null,
    skillUsageTriage: row.skillUsageTriage ?? null,
    pinnedSkillIds: normalizePinnedSkillIds(row.pinnedSkillIds ?? []),
    disabledCatalogPackages: row.disabledCatalogPackages ?? [],
    disabledToolNames: row.disabledToolNames ?? [],
    creativeChat: row.creativeChat ?? null,
    thinkingChat: row.thinkingChat ?? null,
    creativeTriage: row.creativeTriage ?? null,
    thinkingTriage: row.thinkingTriage ?? null,
  };
}

/** True when two pinned-id lists differ in length or order. */
export function pinnedSkillIdsChanged(
  stored: readonly string[],
  next: readonly string[],
): boolean {
  if (stored.length !== next.length) return true;
  for (let i = 0; i < stored.length; i++) {
    if (stored[i] !== next[i]) return true;
  }
  return false;
}

/**
 * Drop pins the member can no longer see (deleted or access revoked). Order of
 * surviving ids is preserved.
 */
export function prunePinnedSkillIdsToVisibleLibrary(
  ids: readonly string[],
  visibleSkillIds: ReadonlySet<string>,
): string[] {
  return normalizePinnedSkillIds(
    ids.filter((id) => visibleSkillIds.has(id)),
  );
}

/** Dedupe while preserving order and cap at {@link MAX_PINNED_MYRA_SKILLS}. */
export function normalizePinnedSkillIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_PINNED_MYRA_SKILLS) break;
  }
  return out;
}

/**
 * Validate pinned skill ids against the member's visible skill library. Returns
 * an error message or `null` when the patch omits `pinnedSkillIds`.
 */
export async function validatePinnedSkillIdsPatch(
  db: HubDb,
  viewer: SkillViewer,
  patch: MyraVariantPreferencePatch,
): Promise<string | null> {
  if (patch.pinnedSkillIds === undefined) return null;
  const ids = patch.pinnedSkillIds;
  if (ids.length > MAX_PINNED_MYRA_SKILLS) {
    return `At most ${MAX_PINNED_MYRA_SKILLS} pinned skills`;
  }
  const visible = await listSkills(db, viewer);
  const allowed = new Set(visible.map((s) => s.id));
  for (const id of ids) {
    if (!allowed.has(id)) {
      return `Unknown or inaccessible skill id: ${id}`;
    }
  }
  return null;
}

export async function readMyraMemberPreferencesWithCatalog(
  db: HubDb,
  tenantId: string,
  memberPrincipalId: string,
): Promise<MyraMemberPreferencesResponse> {
  const { listMemberMyraToolCatalog } = await import(
    "../lib/myra-member-tool-settings"
  );
  const prefs = await readMyraVariantPreference(
    db,
    tenantId,
    memberPrincipalId,
  );
  const rawCatalog = await listMemberMyraToolCatalog(
    db,
    tenantId,
    memberPrincipalId,
  );
  const toolCatalog = rawCatalog.map((entry) => ({
    package: entry.package,
    description: entry.summary,
    tools: entry.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  }));
  return { ...prefs, toolCatalog };
}

const STYLE_AXIS_PATCH_KEYS = [
  ["personality", "personality"],
  ["emojiUse", "emojiUse"],
  ["uiType", "uiType"],
  ["artifactUsageChat", "artifactUsage"],
  ["artifactUsageTriage", "artifactUsage"],
  ["toolUsageChat", "toolUsage"],
  ["toolUsageTriage", "toolUsage"],
  ["skillUsageChat", "skillUsage"],
  ["skillUsageTriage", "skillUsage"],
] as const;

/**
 * Validate a patch against the variant catalog and the style-axes catalog.
 * Returns the offending message when the patch names an unknown variant or
 * option id for its axis, else `null`. A `null` value on any axis is always
 * valid (clears the selection back to its default).
 */
export function validateMyraVariantPatch(
  patch: MyraVariantPreferencePatch,
): string | null {
  if (
    patch.chat !== undefined &&
    patch.chat !== null &&
    !isMyraVariantId(patch.chat, "chat")
  ) {
    return `Unknown chat variant id: ${patch.chat}`;
  }
  if (
    patch.triage !== undefined &&
    patch.triage !== null &&
    !isMyraVariantId(patch.triage, "triage")
  ) {
    return `Unknown triage variant id: ${patch.triage}`;
  }

  for (const [patchKey, axisId] of STYLE_AXIS_PATCH_KEYS) {
    const value = patch[patchKey];
    if (
      value !== undefined &&
      value !== null &&
      !isStyleAxisOptionId(axisId, value)
    ) {
      return `Unknown ${axisId} option id: ${value}`;
    }
  }

  return null;
}

/**
 * Merge a validated patch into the member's stored selection and return the
 * result. Upserts on (tenant, principal); only the axes present in the patch
 * change. The caller MUST have validated with {@link validateMyraVariantPatch}
 * first.
 */
export async function setMyraVariantPreference(
  db: HubDb,
  tenantId: string,
  memberPrincipalId: string,
  patch: MyraVariantPreferencePatch,
): Promise<MyraVariantPreference> {
  const current = await readMyraVariantPreference(
    db,
    tenantId,
    memberPrincipalId,
  );
  const next: MyraVariantPreference = {
    chat: patch.chat !== undefined ? patch.chat : current.chat,
    triage: patch.triage !== undefined ? patch.triage : current.triage,
    instructionsGlobal:
      patch.instructionsGlobal !== undefined
        ? patch.instructionsGlobal
        : current.instructionsGlobal,
    instructionsChat:
      patch.instructionsChat !== undefined
        ? patch.instructionsChat
        : current.instructionsChat,
    instructionsTriage:
      patch.instructionsTriage !== undefined
        ? patch.instructionsTriage
        : current.instructionsTriage,
    personality:
      patch.personality !== undefined ? patch.personality : current.personality,
    emojiUse: patch.emojiUse !== undefined ? patch.emojiUse : current.emojiUse,
    uiType: patch.uiType !== undefined ? patch.uiType : current.uiType,
    artifactUsageChat:
      patch.artifactUsageChat !== undefined
        ? patch.artifactUsageChat
        : current.artifactUsageChat,
    artifactUsageTriage:
      patch.artifactUsageTriage !== undefined
        ? patch.artifactUsageTriage
        : current.artifactUsageTriage,
    toolUsageChat:
      patch.toolUsageChat !== undefined
        ? patch.toolUsageChat
        : current.toolUsageChat,
    toolUsageTriage:
      patch.toolUsageTriage !== undefined
        ? patch.toolUsageTriage
        : current.toolUsageTriage,
    skillUsageChat:
      patch.skillUsageChat !== undefined
        ? patch.skillUsageChat
        : current.skillUsageChat,
    skillUsageTriage:
      patch.skillUsageTriage !== undefined
        ? patch.skillUsageTriage
        : current.skillUsageTriage,
    pinnedSkillIds:
      patch.pinnedSkillIds !== undefined
        ? normalizePinnedSkillIds(patch.pinnedSkillIds)
        : current.pinnedSkillIds,
    disabledCatalogPackages:
      patch.disabledCatalogPackages !== undefined
        ? patch.disabledCatalogPackages
        : current.disabledCatalogPackages,
    disabledToolNames:
      patch.disabledToolNames !== undefined
        ? patch.disabledToolNames
        : current.disabledToolNames,
    creativeChat:
      patch.creativeChat !== undefined
        ? patch.creativeChat
        : current.creativeChat,
    thinkingChat:
      patch.thinkingChat !== undefined
        ? patch.thinkingChat
        : current.thinkingChat,
    creativeTriage:
      patch.creativeTriage !== undefined
        ? patch.creativeTriage
        : current.creativeTriage,
    thinkingTriage:
      patch.thinkingTriage !== undefined
        ? patch.thinkingTriage
        : current.thinkingTriage,
  };

  const needsToolSanitize =
    patch.disabledCatalogPackages !== undefined ||
    patch.disabledToolNames !== undefined ||
    next.disabledCatalogPackages.length > 0 ||
    next.disabledToolNames.length > 0;
  if (needsToolSanitize) {
    const { listMemberMyraToolCatalog, sanitizeMemberMyraToolDisables } =
      await import("../lib/myra-member-tool-settings");
    const catalog = await listMemberMyraToolCatalog(
      db,
      tenantId,
      memberPrincipalId,
    );
    const sanitized = sanitizeMemberMyraToolDisables(
      catalog,
      next.disabledCatalogPackages,
      next.disabledToolNames,
    );
    next.disabledCatalogPackages = sanitized.disabledCatalogPackages;
    next.disabledToolNames = sanitized.disabledToolNames;
  }

  await db
    .insert(myraVariantPreference)
    .values({
      tenantId,
      memberPrincipalId,
      chatVariantId: next.chat,
      triageVariantId: next.triage,
      instructionsGlobal: next.instructionsGlobal,
      instructionsChat: next.instructionsChat,
      instructionsTriage: next.instructionsTriage,
      personality: next.personality,
      emojiUse: next.emojiUse,
      uiType: next.uiType,
      artifactUsageChat: next.artifactUsageChat,
      artifactUsageTriage: next.artifactUsageTriage,
      toolUsageChat: next.toolUsageChat,
      toolUsageTriage: next.toolUsageTriage,
      skillUsageChat: next.skillUsageChat,
      skillUsageTriage: next.skillUsageTriage,
      pinnedSkillIds: next.pinnedSkillIds,
      disabledCatalogPackages: next.disabledCatalogPackages,
      disabledToolNames: next.disabledToolNames,
      creativeChat: next.creativeChat,
      thinkingChat: next.thinkingChat,
      creativeTriage: next.creativeTriage,
      thinkingTriage: next.thinkingTriage,
    })
    .onConflictDoUpdate({
      target: [
        myraVariantPreference.tenantId,
        myraVariantPreference.memberPrincipalId,
      ],
      set: {
        chatVariantId: next.chat,
        triageVariantId: next.triage,
        instructionsGlobal: next.instructionsGlobal,
        instructionsChat: next.instructionsChat,
        instructionsTriage: next.instructionsTriage,
        personality: next.personality,
        emojiUse: next.emojiUse,
        uiType: next.uiType,
        artifactUsageChat: next.artifactUsageChat,
        artifactUsageTriage: next.artifactUsageTriage,
        toolUsageChat: next.toolUsageChat,
        toolUsageTriage: next.toolUsageTriage,
        skillUsageChat: next.skillUsageChat,
        skillUsageTriage: next.skillUsageTriage,
        pinnedSkillIds: next.pinnedSkillIds,
        disabledCatalogPackages: next.disabledCatalogPackages,
        disabledToolNames: next.disabledToolNames,
        creativeChat: next.creativeChat,
        thinkingChat: next.thinkingChat,
        creativeTriage: next.creativeTriage,
        thinkingTriage: next.thinkingTriage,
        updatedAt: new Date(),
      },
    });

  return next;
}
