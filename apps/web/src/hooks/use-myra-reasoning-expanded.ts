import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@workbench/chat";
import {
  clearReasoningExpanded,
  readReasoningExpanded,
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
 * replaces {@link STREAMING_BUBBLE_ID}.
 */
export function useMyraReasoningExpanded(
  messages: ChatMessage[],
): MyraReasoningExpandedPrefs {
  const [revision, setRevision] = useState(0);
  const prevIdsRef = useRef<string[]>([]);

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
    const ids = messages.map((m) => m.id);
    const hadStreaming = prevIdsRef.current.includes(STREAMING_BUBBLE_ID);
    const hasStreaming = ids.includes(STREAMING_BUBBLE_ID);
    if (hadStreaming && !hasStreaming && readReasoningExpanded(STREAMING_BUBBLE_ID)) {
      const lastAgent = [...messages].reverse().find((m) => m.role === "agent");
      if (lastAgent !== undefined) {
        const key = lastAgent.feedbackId ?? lastAgent.id;
        writeReasoningExpanded(key, true);
        clearReasoningExpanded(STREAMING_BUBBLE_ID);
        bump();
      }
    }
    prevIdsRef.current = ids;
  }, [messages, bump]);

  return { isReasoningExpanded, setReasoningExpanded };
}