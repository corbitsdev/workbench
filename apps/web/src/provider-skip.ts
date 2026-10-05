// A person who skips the provider step has a working shell and no Worker yet.
// The flag is per user and client-side only; it never reaches the hub.

import { reportError } from "@corbits/error-sink";
import { useSyncExternalStore } from "react";

import { useSessionUser } from "./navigation";
import { hasUsableModel, type ModelInfo } from "./settings/inference";

const listeners = new Set<() => void>();

function keyFor(userId: string): string {
  return `corbits-provider-skipped:${userId}`;
}

export function isProviderSkipped(userId: string): boolean {
  try {
    return localStorage.getItem(keyFor(userId)) === "1";
  } catch (cause) {
    reportError(cause, { operation: "provider_skip.read" });
    return false;
  }
}

export function setProviderSkipped(userId: string, skipped: boolean): void {
  try {
    if (skipped) localStorage.setItem(keyFor(userId), "1");
    else localStorage.removeItem(keyFor(userId));
  } catch (cause) {
    reportError(cause, { operation: "provider_skip.write" });
  }
  for (const listener of listeners) listener();
}

export function clearProviderSkipWhenUsable(userId: string, models: readonly ModelInfo[]): void {
  if (isProviderSkipped(userId) && hasUsableModel(models)) setProviderSkipped(userId, false);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useProviderSkipped(): boolean {
  const user = useSessionUser();
  return useSyncExternalStore(subscribe, () =>
    user === undefined ? false : isProviderSkipped(user.id),
  );
}
