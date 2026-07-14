import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@workbench/chat";
import {
  clearReasoningExpanded,
  migrateReasoningExpandedSlotKeys,
  readReasoningExpandedForDisplay,
  reconcileReasoningExpandedAliases,
  reasoningExpandedMessageKey,
  writeReasoningExpanded,
} from "@workbench/chat";
import { STREAMING_BUBBLE_ID } from "@workbench/agents/browser";

export type MyraReasoningExpandedPrefs = {
  isReasoningExpanded: (messageKey: string) => boolean;
  setReasoningExpanded: (messageKey: string, expanded: boolean) => void;
};

/**
 * Per-message reasoning disclosure prefs for Myra (localStorage). Migrates an
 * expand choice made on the live streaming bubble when the settled mail id
 * replaces {@link STREAMING_BUBBLE_ID}, and when composeChat remaps turn/mail
 * ids (including after a hard reload). Aged turns (24h+) auto-collapse on
 * display even when expand was persisted; see {@link readReasoningExpandedForDisplay}.
 */
export function useMyraReasoningExpanded(
  messages: ChatMessage[],
): MyraReasoningExpandedPrefs {
  const [revision, setRevision] = useState(0);
  const prevIdsRef = useRef<string[]>([]);
  const prevAgentSlotsRef = useRef<
    { id: string; feedbackId?: string | undefined }[]
  >([]);

  const bump = useCallback(() => setRevision((n) => n + 1), []);

  const createdAtByKey = useCallback(() => {
    const map = new Map<string, string>();
    for (const message of messages) {
      if (message.role !== "agent") continue;
      const key = reasoningExpandedMessageKey(message);
      map.set(key, message.createdAt);
      map.set(message.id, message.createdAt);
      if (message.feedbackId !== undefined) {
        map.set(message.feedbackId, message.createdAt);
      }
    }
    return map;
  }, [messages]);

  const isReasoningExpanded = useCallback(
    (messageKey: string) => {
      void revision;
      const createdAt = createdAtByKey().get(messageKey);
      return readReasoningExpandedForDisplay(messageKey, createdAt);
    },
    [revision, createdAtByKey],
  );

  const setReasoningExpanded = useCallback(
    (messageKey: string, expanded: boolean) => {
      writeReasoningExpanded(messageKey, expanded);
      bump();
    },
    [bump],
  );

  useEffect(() => {
    let migrated = false;
    const ids = messages.map((m) => m.id);
    const hadStreaming = prevIdsRef.current.includes(STREAMING_BUBBLE_ID);
    const hasStreaming = ids.includes(STREAMING_BUBBLE_ID);
    if (
      hadStreaming &&
      !hasStreaming &&
      readReasoningExpandedForDisplay(STREAMING_BUBBLE_ID, undefined)
    ) {
      const lastAgent = [...messages].reverse().find((m) => m.role === "agent");
      if (lastAgent !== undefined) {
        const key = reasoningExpandedMessageKey(lastAgent);
        writeReasoningExpanded(key, true);
        clearReasoningExpanded(STREAMING_BUBBLE_ID);
        migrated = true;
      }
    }

    const agentSlots = messages
      .filter(
        (m) => m.role === "agent" && (m.reasoning ?? "").trim() !== "",
      )
      .map((m) => ({ id: m.id, feedbackId: m.feedbackId }));

    if (
      migrateReasoningExpandedSlotKeys(
        prevAgentSlotsRef.current,
        agentSlots,
      )
    ) {
      migrated = true;
    }
    if (reconcileReasoningExpandedAliases(messages)) {
      migrated = true;
    }

    prevIdsRef.current = ids;
    prevAgentSlotsRef.current = agentSlots;
    if (migrated) bump();
  }, [messages, bump]);

  return { isReasoningExpanded, setReasoningExpanded };
}