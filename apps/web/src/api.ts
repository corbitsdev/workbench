// The interface's one seam to the hub: relative /api paths on the origin the
// bundle was served from, validated at the boundary with the platform's own
// response schemas so a shape change surfaces as an error state, never as
// undefined leaking into a page.

import {
  ApprovalSummary,
  PrincipalSummary,
  UserProfile,
  WorkflowRunSummary,
  paginatedSchema,
} from "@intx/types";
import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { useEffect, useState } from "react";

export const ProfileSchema = UserProfile;
export const PrincipalsSchema = paginatedSchema(PrincipalSummary);
export const RunsSchema = paginatedSchema(WorkflowRunSummary);
export const ApprovalsSchema = ApprovalSummary.array();

export type Profile = typeof UserProfile.infer;
export type Principal = typeof PrincipalSummary.infer;
export type WorkflowRun = typeof WorkflowRunSummary.infer;
export type Approval = typeof ApprovalSummary.infer;

/**
 * The envelope paginatedSchema validates, stated structurally: the generic
 * schema's inferred type carries an arktype inference artifact that rejects
 * plain literals, so pages and tests use this equivalent shape instead.
 */
type Paginated<T> = { data: T[]; nextCursor: string | null };
export type PrincipalsPage = Paginated<Principal>;
export type RunsPage = Paginated<WorkflowRun>;

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
  /** Bump this to force a re-fetch of an otherwise-unchanged path, e.g.
   * after a mutation the hub doesn't push updates for. */
  reloadKey: number = 0,
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
  }, [path, schema, reloadKey]);

  return state;
}
