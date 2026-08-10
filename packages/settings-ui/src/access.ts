// Whether the People/Roles/Grants/Credentials sections belong in the
// settings nav at all, decided the way the rest of this surface's og
// pages already gate access: never a disabled tab, just an absent one.
// There's no capability listing to read this off of, so this probes the
// one grant-checked route that requires no grant of its own —
// `evaluate` — for the resource each section is built on.

import { useEffect, useState } from "react";

import { evaluate } from "./tenancy-api";

export type SectionAccess = "loading" | "allowed" | "denied";

export type TenancyAccess = {
  readonly people: SectionAccess;
  readonly roles: SectionAccess;
  readonly grants: SectionAccess;
  readonly credentials: SectionAccess;
};

function useResourceAccess(
  tenantId: string | null,
  principalId: string | null,
  resource: string,
): SectionAccess {
  const [access, setAccess] = useState<SectionAccess>("loading");

  useEffect(() => {
    if (tenantId === null || principalId === null) {
      setAccess("loading");
      return;
    }
    let cancelled = false;
    setAccess("loading");
    evaluate(tenantId, principalId, resource, "read")
      .then((result) => {
        if (!cancelled)
          setAccess(result.effect === "allow" ? "allowed" : "denied");
      })
      .catch(() => {
        if (!cancelled) setAccess("denied");
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, principalId, resource]);

  return access;
}

/** One probe per section, run in parallel — a section stays out of the nav
 * until its probe resolves `allowed`, so a slow or failed probe reads as
 * "not shown yet", never as a visible-but-disabled tab. */
export function useTenancyAccess(
  tenantId: string | null,
  principalId: string | null,
): TenancyAccess {
  return {
    people: useResourceAccess(tenantId, principalId, "principal"),
    roles: useResourceAccess(tenantId, principalId, "role"),
    grants: useResourceAccess(tenantId, principalId, "grant"),
    credentials: useResourceAccess(tenantId, principalId, "credential"),
  };
}
