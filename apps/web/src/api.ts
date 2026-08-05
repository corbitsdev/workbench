// The interface's one seam to the hub: relative /api paths on the origin the
// bundle was served from, validated at the boundary with the platform's own
// response schemas so a shape change surfaces as an error state, never as
// undefined leaking into a page.

import {
  AgentSummary,
  ApprovalSummary,
  InstanceSummary,
  PrincipalSummary,
  UserProfile,
  paginatedSchema,
} from "@intx/types";
import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { useEffect, useState } from "react";

export const ProfileSchema = UserProfile;
export const PrincipalsSchema = paginatedSchema(PrincipalSummary);
export const AgentsSchema = paginatedSchema(AgentSummary);
export const InstancesSchema = paginatedSchema(InstanceSummary);
export const ApprovalsSchema = ApprovalSummary.array();

export type Profile = typeof UserProfile.infer;
export type Principal = typeof PrincipalSummary.infer;
export type Agent = typeof AgentSummary.infer;
export type Instance = typeof InstanceSummary.infer;
export type Approval = typeof ApprovalSummary.infer;
export type PrincipalsPage = typeof PrincipalsSchema.infer;
export type AgentsPage = typeof AgentsSchema.infer;
export type InstancesPage = typeof InstancesSchema.infer;

export type APIQuery<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: T };

/** An arktype schema, seen as the validating call every `Type` provides. */
type Validator<T> = (data: unknown) => T | ArkErrors;

/**
 * Fetches one hub endpoint and reports exactly what happened: loading, no
 * session (401), a failure, or validated data. Pass a module-level schema so
 * the effect does not re-run on every render.
 */
export function useAPIQuery<T>(
  path: string,
  schema: Validator<T>,
): APIQuery<T> {
  const [state, setState] = useState<APIQuery<T>>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const settle = (next: APIQuery<T>) => {
      if (!cancelled) setState(next);
    };
    void (async () => {
      try {
        const response = await fetch(path, {
          headers: { accept: "application/json" },
        });
        if (response.status === 401) {
          settle({ kind: "unauthenticated" });
          return;
        }
        if (!response.ok) {
          settle({
            kind: "error",
            message: `The hub answered ${response.status} for ${path}.`,
          });
          return;
        }
        const parsed = schema(await response.json());
        if (parsed instanceof type.errors) {
          settle({
            kind: "error",
            message: `Unexpected response shape from ${path}: ${parsed.summary}`,
          });
          return;
        }
        settle({ kind: "ready", data: parsed });
      } catch (cause) {
        settle({
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, schema]);

  return state;
}
