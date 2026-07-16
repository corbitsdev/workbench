import { useQuery } from "@tanstack/react-query";
import { type } from "arktype";
import { hubFetch } from "./hub-api";

/**
 * The two Myra surfaces a member can pick a definition for: interactive chat
 * threads and unattended inbox-triage automation runs.
 */
export const MyraVariantSchema = type({
  id: "string",
  kind: "'chat' | 'triage'",
  displayName: "string",
  model: "string",
  description: "string",
  isDefault: "boolean",
  costTier: "'standard' | 'premium'",
});
export type MyraVariant = typeof MyraVariantSchema.infer;

export const MyraVariantsResponseSchema = type({
  variants: MyraVariantSchema.array(),
});
export type MyraVariantsResponse = typeof MyraVariantsResponseSchema.infer;

/**
 * A member's chosen variant per surface. `null` means "follow the canonical
 * default" — the variant whose `isDefault` is true — rather than a pinned id.
 * The personalization style axes ride on the same record: `personality` /
 * `emojiUse` / `uiType` are global; the three usage dials are per-surface.
 * `null` on any axis means "use that axis's default option".
 */
export const MyraPreferencesSchema = type({
  chat: "string | null",
  triage: "string | null",
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
});
export type MyraPreferences = typeof MyraPreferencesSchema.infer;

export const MyraPreferencesUpdateSchema = type({
  "chat?": "string | null",
  "triage?": "string | null",
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
});
export type MyraPreferencesUpdate = typeof MyraPreferencesUpdateSchema.infer;

/**
 * The style-axes catalog (id/label/description per option; no prompt
 * snippet text is shipped to the client). `personality` / `emojiUse` /
 * `uiType` axes apply globally; `artifactUsage` / `toolUsage` / `skillUsage`
 * each back two preference fields (…Chat / …Triage) for the per-surface
 * split.
 */
export const StyleAxisOptionSchema = type({
  id: "string",
  label: "string",
  description: "string",
});
export type StyleAxisOption = typeof StyleAxisOptionSchema.infer;

export const StyleAxisSchema = type({
  id: "'personality' | 'emojiUse' | 'uiType' | 'artifactUsage' | 'toolUsage' | 'skillUsage'",
  label: "string",
  description: "string",
  defaultOptionId: "string",
  options: StyleAxisOptionSchema.array(),
});
export type StyleAxis = typeof StyleAxisSchema.infer;
export type StyleAxisId = StyleAxis["id"];

export const StyleAxesResponseSchema = type({
  axes: StyleAxisSchema.array(),
});

function myraBase(tenantId: string): string {
  return `tenants/${encodeURIComponent(tenantId)}`;
}

export async function getMyraVariants(
  tenantId: string,
): Promise<MyraVariant[]> {
  const raw = await hubFetch<unknown>(
    "GET",
    `${myraBase(tenantId)}/myra/variants`,
  );
  const parsed = MyraVariantsResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid Myra variants response: ${parsed.summary}`);
  }
  return parsed.variants;
}

export async function getMyraStyleAxes(
  tenantId: string,
): Promise<StyleAxis[]> {
  const raw = await hubFetch<unknown>(
    "GET",
    `${myraBase(tenantId)}/myra/style-axes`,
  );
  const parsed = StyleAxesResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid Myra style-axes response: ${parsed.summary}`);
  }
  return parsed.axes;
}

export async function getMyraPreferences(
  tenantId: string,
): Promise<MyraPreferences> {
  const raw = await hubFetch<unknown>(
    "GET",
    `${myraBase(tenantId)}/members/me/myra-preferences`,
  );
  const parsed = MyraPreferencesSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid Myra preferences response: ${parsed.summary}`);
  }
  return parsed;
}

export async function putMyraPreferences(
  tenantId: string,
  body: MyraPreferencesUpdate,
): Promise<MyraPreferences> {
  const raw = await hubFetch<unknown>(
    "PUT",
    `${myraBase(tenantId)}/members/me/myra-preferences`,
    body,
  );
  const parsed = MyraPreferencesSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid Myra preferences response: ${parsed.summary}`);
  }
  return parsed;
}

export function myraVariantsKey(tenantId: string | null) {
  return ["myra-variants", tenantId] as const;
}

export function myraStyleAxesKey(tenantId: string | null) {
  return ["myra-style-axes", tenantId] as const;
}

export function myraPreferencesKey(tenantId: string | null) {
  return ["myra-preferences", tenantId] as const;
}

export function useMyraVariants(tenantId: string | null) {
  return useQuery<MyraVariant[]>({
    queryKey: myraVariantsKey(tenantId),
    queryFn: () => {
      if (tenantId === null) throw new Error("tenantId is required");
      return getMyraVariants(tenantId);
    },
    enabled: tenantId !== null,
    staleTime: 5 * 60_000,
  });
}

export function useMyraStyleAxes(tenantId: string | null) {
  return useQuery<StyleAxis[]>({
    queryKey: myraStyleAxesKey(tenantId),
    queryFn: () => {
      if (tenantId === null) throw new Error("tenantId is required");
      return getMyraStyleAxes(tenantId);
    },
    enabled: tenantId !== null,
    staleTime: 5 * 60_000,
  });
}

export function useMyraPreferences(tenantId: string | null) {
  return useQuery<MyraPreferences>({
    queryKey: myraPreferencesKey(tenantId),
    queryFn: () => {
      if (tenantId === null) throw new Error("tenantId is required");
      return getMyraPreferences(tenantId);
    },
    enabled: tenantId !== null,
    staleTime: 5 * 60_000,
  });
}

/**
 * The variant a surface currently resolves to: the member's pinned id when set
 * and still present in the catalog, otherwise the canonical default variant.
 */
export function selectedVariantId(
  variants: readonly MyraVariant[],
  preference: string | null,
): string | null {
  if (preference !== null && variants.some((v) => v.id === preference)) {
    return preference;
  }
  const fallback = variants.find((v) => v.isDefault);
  return fallback?.id ?? null;
}
