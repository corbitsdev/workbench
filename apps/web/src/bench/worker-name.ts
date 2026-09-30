// The worker's name is bench state in the tenant config, never a redeploy:
// the worker states it on its first reply and the person can rename it.

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { type } from "arktype";

import type { WorkbenchMessage, WorkbenchParticipant } from "@/chat/threads-api";
import { sameAddress } from "@/chat/threads-api";
import { fetchTenantDetail, type TenantDetail } from "../api";
import { patchTenantConfigKey } from "./tenant-config";

export const DEFAULT_WORKER_NAME = "New worker";
export const WORKER_NAME_MAX = 24;
const CONFIG_KEY = "workbench.worker.name";

const NameConfig = type({ "workbench.worker.name?": "string" });

const NAME_PATTERN = /^[\p{L} -]+$/u;

/** A name the bench accepts: trimmed, short, letters, spaces and hyphens. */
export function validWorkerName(raw: string): string | undefined {
  const name = raw.trim();
  return name.length > 0 && name.length <= WORKER_NAME_MAX && NAME_PATTERN.test(name)
    ? name
    : undefined;
}

function readWorkerName(config: TenantDetail["config"]): string | undefined {
  const parsed = NameConfig(config ?? {});
  if (parsed instanceof type.errors) return undefined;
  const stored = parsed["workbench.worker.name"];
  return stored === undefined ? undefined : validWorkerName(stored);
}

const nameKey = (tenantId: string) => ["workbench", tenantId, "worker-name"] as const;

const nameQuery = (tenantId: string) => ({
  queryKey: nameKey(tenantId),
  queryFn: async () => readWorkerName((await fetchTenantDetail(tenantId)).config) ?? null,
});

const NAME_LINE = /\n[ \t]*Name:[ \t]*([^\n]+?)[ \t]*$/i;

/** The name a worker message ends with, when it ends with a valid
 * `Name: <name>` line. */
export function nameFromMessage(body: string): string | undefined {
  const match = NAME_LINE.exec(body.trimEnd());
  return match?.[1] === undefined ? undefined : validWorkerName(match[1]);
}

/** The message as rendered: a valid trailing `Name:` line is never shown. */
export function stripNameLine(body: string): string {
  const trimmed = body.trimEnd();
  return nameFromMessage(trimmed) === undefined ? body : trimmed.replace(NAME_LINE, "");
}

/** The stored name, or undefined until one exists; `save` renames. */
export function useWorkerName(tenantId: string) {
  const queryClient = useQueryClient();
  const query = useQuery(nameQuery(tenantId));
  const save = useMutation({
    mutationFn: (name: string) => setWorkerName(tenantId, name),
    onSuccess: (name) => queryClient.setQueryData(nameKey(tenantId), name),
  });
  return {
    name: query.data ?? undefined,
    loaded: query.isSuccess,
    save,
  };
}

export async function setWorkerName(tenantId: string, name: string): Promise<string> {
  const valid = validWorkerName(name);
  if (valid === undefined) {
    throw new Error("Use up to 24 letters, spaces or hyphens.");
  }
  await patchTenantConfigKey(tenantId, CONFIG_KEY, valid);
  return valid;
}

/** Stored names of many benches, by bench id; a bench with none reads as
 * `DEFAULT_WORKER_NAME`. */
export function useWorkerNames(tenantIds: readonly string[]): ReadonlyMap<string, string> {
  const results = useQueries({ queries: tenantIds.map(nameQuery) });
  return new Map(tenantIds.map((id, i) => [id, results[i]?.data ?? DEFAULT_WORKER_NAME]));
}

/** Participants with the bench's worker shown under its stored name. */
export function nameWorkers(
  participants: readonly WorkbenchParticipant[],
  name: string | undefined,
): readonly WorkbenchParticipant[] {
  return participants.map((p) =>
    p.kind === "agent" ? { ...p, name: name ?? DEFAULT_WORKER_NAME } : p,
  );
}

/** The first worker message that states a name, for a bench with none. */
export function firstStatedName(
  messages: readonly WorkbenchMessage[],
  participants: readonly WorkbenchParticipant[],
): string | undefined {
  for (const message of messages) {
    if (message.author !== "other") continue;
    const sender = participants.find((p) => sameAddress(p.address, message.address));
    if (sender !== undefined && sender.kind !== "agent") continue;
    const name = nameFromMessage(message.body);
    if (name !== undefined) return name;
  }
  return undefined;
}
