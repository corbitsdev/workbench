import type { RosterInstance } from "@workbench/client";
import { actorHref } from "../pages/insights/ActorActivity";

/** Principal trace for the Myra instance backing this chat thread. */
export function myraInstanceTraceHref(
  instanceId: string | null | undefined,
  instances: readonly RosterInstance[] | undefined,
): string | undefined {
  if (instanceId === null || instanceId === undefined || instanceId === "") {
    return undefined;
  }
  if (instances === undefined) {
    return undefined;
  }
  const row = instances.find((i) => i.instanceId === instanceId);
  if (row === undefined) {
    return undefined;
  }
  return actorHref(row.principalId);
}
