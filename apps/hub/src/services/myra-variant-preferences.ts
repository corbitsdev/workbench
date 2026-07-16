import { and, eq } from "drizzle-orm";
import { type } from "arktype";
import { isMyraVariantId } from "@workbench/myra";
import { myraVariantPreference } from "../db/schema";
import type { HubDb } from "../db";

/**
 * Max length of a single standing-instructions field (global or per-surface
 * override), enforced at the API boundary via the arktype patch schema.
 */
export const MYRA_INSTRUCTIONS_MAX_LENGTH = 4000;

/**
 * A member's stored default-variant selection plus their standing guidance
 * for Myra. `null` on the variant axes means "use the canonical default";
 * `null`/absent on the instructions axes means "nothing set" — the prompt
 * builder renders nothing for either. This is the read shape returned by GET
 * and PUT.
 */
export const MyraVariantPreferenceSchema = type({
  chat: "string | null",
  triage: "string | null",
  instructionsGlobal: "string | null",
  instructionsChat: "string | null",
  instructionsTriage: "string | null",
});
export type MyraVariantPreference = typeof MyraVariantPreferenceSchema.infer;

const InstructionsFieldSchema = type(
  `string <= ${MYRA_INSTRUCTIONS_MAX_LENGTH} | null`,
);

/**
 * The PUT patch: every field may be omitted (left untouched), set to a value,
 * or set to `null` (cleared). Instructions fields are length-capped at
 * {@link MYRA_INSTRUCTIONS_MAX_LENGTH} characters.
 */
export const MyraVariantPreferencePatchSchema = type({
  "chat?": "string | null",
  "triage?": "string | null",
  "instructionsGlobal?": InstructionsFieldSchema,
  "instructionsChat?": InstructionsFieldSchema,
  "instructionsTriage?": InstructionsFieldSchema,
});
export type MyraVariantPreferencePatch =
  typeof MyraVariantPreferencePatchSchema.infer;

const EMPTY_PREFERENCE: MyraVariantPreference = {
  chat: null,
  triage: null,
  instructionsGlobal: null,
  instructionsChat: null,
  instructionsTriage: null,
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
    instructionsGlobal: row.instructionsGlobal,
    instructionsChat: row.instructionsChat,
    instructionsTriage: row.instructionsTriage,
  };
}

/**
 * Validate a patch against the variant catalog. Returns the offending message
 * when the patch names an unknown variant for its axis, else `null`. A `null`
 * value on either axis is always valid (clears the selection).
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
  };

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
        updatedAt: new Date(),
      },
    });

  return next;
}
