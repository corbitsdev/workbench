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
 */
export const MyraPreferencesSchema = type({
  chat: "string | null",
  triage: "string | null",
});
export type MyraPreferences = typeof MyraPreferencesSchema.infer;

export const MyraPreferencesUpdateSchema = type({
  "chat?": "string | null",
  "triage?": "string | null",
});
export type MyraPreferencesUpdate = typeof MyraPreferencesUpdateSchema.infer;

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
