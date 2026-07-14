import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@workbench/chat";
import {
  clearReasoningExpanded,
  migrateReasoningExpandedSlotKeys,
  readReasoningExpanded,
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
 * ids (including after a hard reload).
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

  const isReasoningExpanded = useCallback(
    (messageKey: string) => {
      void revision;
      return readReasoningExpanded(messageKey);
    },
    [revision],
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
    if (hadStreaming && !hasStreaming && readReasoningExpanded(STREAMING_BUBBLE_ID)) {
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