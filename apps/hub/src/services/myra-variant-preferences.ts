import { and, eq } from "drizzle-orm";
import { type } from "arktype";
import { isMyraVariantId } from "@workbench/myra";
import { myraVariantPreference } from "../db/schema";
import type { HubDb } from "../db";

/**
 * A member's stored default-variant selection. `null` on either axis means "use
 * the canonical default" — the byte-identical current behavior. This is the
 * read shape returned by GET and PUT.
 */
export const MyraVariantPreferenceSchema = type({
  chat: "string | null",
  triage: "string | null",
});
export type MyraVariantPreference = typeof MyraVariantPreferenceSchema.infer;

/**
 * The PUT patch: either axis may be omitted (left untouched), set to a variant
 * id, or set to `null` (cleared back to the canonical default).
 */
export const MyraVariantPreferencePatchSchema = type({
  "chat?": "string | null",
  "triage?": "string | null",
});
export type MyraVariantPreferencePatch =
  typeof MyraVariantPreferencePatchSchema.infer;

const EMPTY_PREFERENCE: MyraVariantPreference = { chat: null, triage: null };

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
  return { chat: row.chatVariantId, triage: row.triageVariantId };
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
  };

  await db
    .insert(myraVariantPreference)
    .values({
      tenantId,
      memberPrincipalId,
      chatVariantId: next.chat,
      triageVariantId: next.triage,
    })
    .onConflictDoUpdate({
      target: [
        myraVariantPreference.tenantId,
        myraVariantPreference.memberPrincipalId,
      ],
      set: {
        chatVariantId: next.chat,
        triageVariantId: next.triage,
        updatedAt: new Date(),
      },
    });

  return next;
}
