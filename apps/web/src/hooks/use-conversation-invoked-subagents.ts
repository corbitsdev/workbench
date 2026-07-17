import { useQuery } from "@tanstack/react-query";
import { type } from "arktype";
import { api } from "../lib/api";
import {
  CONVERSATION_RUN_IDLE_POLL_MS,
  CONVERSATION_RUN_POLL_MS,
} from "./use-workflow";

function withTenant(path: string, tenantId?: string | null): string {
  if (!tenantId) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}tenantId=${encodeURIComponent(tenantId)}`;
}

const invokedSubagentSchema = type({
  mappingId: "string",
  agentId: "string",
  agentName: "string",
  instanceId: "string",
  instanceAddress: "string",
  sessionId: "string | null",
  sessionStatus: "string | null",
  lastActivityAt: "string",
  firstInvokedAt: "string",
  lastInvokedAt: "string",
  originConversationId: "string | null",
});
export type ConversationInvokedSubagent = typeof invokedSubagentSchema.infer;

const invokedSubagentsResponseSchema = type({
  subagents: invokedSubagentSchema.array(),
});

export function subagentSessionIsActive(sessionStatus: string | null): boolean {
  return sessionStatus === "active";
}

export function invokedSubagentListIsActive(
  subagents: readonly { sessionStatus: string | null }[],
): boolean {
  return subagents.some((row) => subagentSessionIsActive(row.sessionStatus));
}

export function invokedSubagentPollInterval(
  subagents: readonly { sessionStatus: string | null }[] | undefined,
): number {
  if (subagents === undefined || invokedSubagentListIsActive(subagents)) {
    return CONVERSATION_RUN_POLL_MS;
  }
  return CONVERSATION_RUN_IDLE_POLL_MS;
}

/** Display status for dock sorting and chrome (CL-3686). */
export type InvokedSubagentDockStatus = "running" | "completed";

export function invokedSubagentDockStatus(
  sessionStatus: string | null,
): InvokedSubagentDockStatus {
  return subagentSessionIsActive(sessionStatus) ? "running" : "completed";
}

/**
 * Subagents invoked from the open Myra thread (CL-3686). `conversationId` is the
 * thread id; the hub scopes rows via `originConversationId`. Polls on the shared
 * conversation dock cadence while any listed subagent session is active.
 */
export function useConversationInvokedSubagents(
  conversationId: string | null,
  tenantId?: string | null,
) {
  return useQuery<ConversationInvokedSubagent[]>({
    queryKey: [
      "conversation-invoked-subagents",
      conversationId,
      tenantId ?? null,
    ],
    enabled: conversationId !== null && conversationId !== "",
    refetchInterval: (query) => invokedSubagentPollInterval(query.state.data),
    queryFn: async () => {
      const raw = await api<unknown>(
        "GET",
        withTenant(
          `/invoked-subagents?originConversationId=${encodeURIComponent(conversationId as string)}`,
          tenantId,
        ),
      );
      const parsed = invokedSubagentsResponseSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(
          `Unexpected invoked-subagents response: ${parsed.summary}`,
        );
      }
      return parsed.subagents;
    },
  });
}
