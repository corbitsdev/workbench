import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createInstanceSession, type InstanceSession } from "@intx/hub-client";
import {
  composeChatMessages,
  friendlyToolSummary,
  friendlyToolResult,
  summarizeToolCalls,
  isCatalogMetaTool,
  isExternalIntegrationTool,
  createPartAssembler,
  type PartAssembler,
} from "@workbench/agents/browser";
import {
  ChatPanel,
  type ChatAgentIdentity,
  type ChatMessage,
  type ChatActivity,
  type ToolCall,
  type UIBlock,
  type UIResponse,
} from "@workbench/chat";
import { useCompactToolActivity, useToolSummaryStyle } from "@workbench/ui";
import { createArtifact } from "@workbench/client";
import { clientOptions } from "../lib/client-options";
import { createChatToolSummaryFormatter } from "../lib/chat-tool-summary";
import { useApprovalDisplayLookups } from "../hooks/use-approval-display-lookups";
import { renderChatToolMarker } from "./ToolCallProviderMarker";
import {
  abortInstanceTurn,
  getOutputFeedback,
  launchInstanceSession,
  saveOutputFeedback,
  upsertRating,
} from "../lib/hub-api";
import type { FeedbackSubjectKind, SavedRating } from "../lib/hub-api";
import {
  createHubTransport,
  fetchBlobObjectUrl,
} from "../lib/instance-transport";
import {
  classifyLaunchState,
  isLaunchableStatus,
} from "./agent-launch-helpers";

// While a sidecar is restarting, the launch endpoint reports a transient
// "no sidecar available" error. Re-attempt the launch on an interval so the
// agent comes up on its own once the sidecar reconnects, instead of leaving the
// user stranded on a "waiting…" notice. Bounded so a genuinely-down sidecar
// eventually surfaces a retryable error instead of spinning forever.
const DEFAULT_RETRY_DELAY_MS = 4000;
const MAX_TRANSIENT_RETRIES = 8;

type DocumentBlock = Extract<UIBlock, { kind: "document" }>;

function downloadMarkdown(title: string, source: string): void {
  const safeName = title.trim().replace(/[\\/:*?"<>|]/gu, "-");
  const blob = new Blob([source], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeName === "" ? "document" : safeName}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

type SessionState =
  | { phase: "loading" }
  | { phase: "pending"; reason: "deploying" | "connecting" }
  | { phase: "ready"; session: InstanceSession }
  | { phase: "missing-config"; message: string }
  | { phase: "error"; message: string };

interface AgentChatProps {
  instanceId: string;
  tenantId: string;
  agentName: string;
  instanceStatus?: string;
  onClose?: () => void;
  onConfigureAgent?: () => void;
  retryDelayMs?: number;
}

export function AgentChat({
  instanceId,
  tenantId,
  agentName,
  instanceStatus,
  onClose,
  onConfigureAgent,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}: AgentChatProps) {
  const identity: ChatAgentIdentity = { name: agentName };
  const { compact: compactToolActivity } = useCompactToolActivity();
  const { style: toolSummaryStyle } = useToolSummaryStyle();
  const { lookups, isLoading: approvalLookupsLoading } =
    useApprovalDisplayLookups(tenantId);
  const formatToolSummary = useMemo(
    () => createChatToolSummaryFormatter(lookups, approvalLookupsLoading),
    [lookups, approvalLookupsLoading],
  );
  const summarize = (calls: ToolCall[]) =>
    summarizeToolCalls(calls, toolSummaryStyle);

  const isLaunchable = isLaunchableStatus(instanceStatus);
  const [sessionState, setSessionState] = useState<SessionState>(
    isLaunchable
      ? { phase: "loading" }
      : { phase: "pending", reason: "deploying" },
  );
  const [, forceUpdate] = useState(0);

  const sessionRef = useRef<InstanceSession | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const assemblerRef = useRef<PartAssembler | null>(null);
  const attachmentUrlsRef = useRef<Map<string, Promise<string>>>(new Map());
  const queryClient = useQueryClient();

  const { data: ratingsData } = useQuery({
    queryKey: ["feedback", instanceId],
    queryFn: () => getOutputFeedback(instanceId),
    enabled: !!instanceId,
    staleTime: 5 * 60_000,
  });

  const ratingsMap = useMemo(
    () =>
      new Map(
        (ratingsData ?? []).map((r) => [
          `${r.subjectId}:${r.subjectKind}`,
          r.rating,
        ]),
      ),
    [ratingsData],
  );

  const { mutateAsync: rateMutateAsync } = useMutation({
    mutationFn: ({
      subjectId,
      subjectKind,
      rating,
    }: {
      subjectId: string;
      subjectKind: FeedbackSubjectKind;
      rating: 1 | -1;
    }) => saveOutputFeedback(instanceId, subjectId, subjectKind, rating),
    onSuccess: (_, { subjectId, subjectKind, rating }) => {
      queryClient.setQueryData<SavedRating[]>(
        ["feedback", instanceId],
        (prev) => upsertRating(prev, { subjectId, subjectKind, rating }),
      );
    },
  });

  const { mutateAsync: abortMutateAsync } = useMutation({
    mutationFn: () => abortInstanceTurn(instanceId),
  });
  // The sidecar settles an aborted turn by putting the agent to sleep, which
  // emits no further agent events. Rather than a second suppression signal,
  // the assembler closes its own open part locally so the derived activity
  // settles to null immediately.
  const abortTurn = useCallback(async (): Promise<void> => {
    try {
      await abortMutateAsync();
    } catch (err) {
      const message =
        err instanceof Error && err.message.trim().length > 0
          ? err.message
          : `Couldn't stop ${agentName}. Try again.`;
      throw new Error(message);
    }
    assemblerRef.current?.closeOpenPart();
  }, [abortMutateAsync, agentName]);

  // Feedback line for document block actions (copy / save-artifact).
  // Successes auto-dismiss; failures stay until the user dismisses them or a
  // subsequent action replaces them — an auto-dismissing error can vanish
  // before the user has read it.
  const [actionNotice, setActionNotice] = useState<{
    text: string;
    variant: "success" | "failure";
  } | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashActionNotice = useCallback(
    (text: string, variant: "success" | "failure" = "success") => {
      setActionNotice({ text, variant });
      if (noticeTimerRef.current !== null) {
        clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
      if (variant === "success") {
        noticeTimerRef.current = setTimeout(() => setActionNotice(null), 4000);
      }
    },
    [],
  );
  const dismissActionNotice = useCallback(() => {
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setActionNotice(null);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const { mutate: saveDocumentArtifact } = useMutation({
    mutationFn: (block: DocumentBlock) =>
      createArtifact(clientOptions, {
        tenantId,
        mode: "text",
        title: block.title,
        content: block.source,
        generatedBy: agentName,
      }),
    onSuccess: (artifact) =>
      flashActionNotice(`Saved "${artifact.title}" to artifacts.`),
    onError: () =>
      flashActionNotice(
        "Couldn't save to artifacts. Please try again.",
        "failure",
      ),
  });

  const { mutate: launch, status: launchStatus } = useMutation({
    mutationFn: async () => {
      const result = await launchInstanceSession(instanceId);
      if (!result.launched) {
        const launchError =
          result.launchError ?? "Failed to launch agent session";
        const classified = classifyLaunchState(instanceStatus, launchError);
        if (
          classified.kind === "connecting" ||
          classified.kind === "deploying"
        ) {
          setSessionState({
            phase: "pending",
            reason:
              classified.kind === "deploying" ? "deploying" : "connecting",
          });
        }
        throw new Error(launchError);
      }
      return result;
    },
    retry: (failureCount, error) => {
      const launchError =
        error instanceof Error ? error.message : String(error);
      const classified = classifyLaunchState(instanceStatus, launchError);
      return (
        (classified.kind === "connecting" || classified.kind === "deploying") &&
        failureCount < MAX_TRANSIENT_RETRIES
      );
    },
    retryDelay: retryDelayMs,
    onError: (err) => {
      const launchError = err instanceof Error ? err.message : String(err);
      const classified = classifyLaunchState(instanceStatus, launchError);
      if (classified.kind === "connecting" || classified.kind === "deploying") {
        setSessionState({ phase: "pending", reason: classified.kind });
      } else if (classified.kind === "missing-config") {
        setSessionState({
          phase: "missing-config",
          message: classified.message,
        });
      } else {
        setSessionState({ phase: "error", message: classified.message });
      }
    },
  });

  // Reset state and trigger launch when instanceId changes (or on mount).
  // Skip launch only when the instance is not launchable (stopped/provisioning)
  // — show the passive deploying notice instead.
  useEffect(() => {
    if (!isLaunchable) return;
    setSessionState({ phase: "loading" });
    launch();
  }, [instanceId, isLaunchable]);

  // Subscription lifecycle — syncs to the external Interchange session.
  // Runs after launch succeeds so hydration errors do not hide launch failures.
  useEffect(() => {
    if (launchStatus !== "success") return;

    let cancelled = false;

    // A stream that never opens (e.g. a 401) gives up after a bounded number
    // of attempts and reports here rather than retrying forever (CL-3148).
    // Tear the session down so the failed subscription's last unsubscribe
    // fires, matching the cleanup below.
    const transport = createHubTransport({
      onStreamError: (err) => {
        if (cancelled) return;
        setSessionState({ phase: "error", message: err.message });
        stopRef.current?.();
        stopRef.current = null;
        assemblerRef.current?.stop();
        assemblerRef.current = null;
        sessionRef.current?.destroy();
        sessionRef.current = null;
      },
    });
    const session = createInstanceSession({
      tenantId,
      instanceId,
      transport,
      onChange: () => {
        if (!cancelled) forceUpdate((n) => n + 1);
      },
      onError: (err) => {
        if (!cancelled)
          setSessionState({ phase: "error", message: err.message });
      },
    });

    sessionRef.current = session;
    const stop = session.start();
    stopRef.current = stop;

    // Single subscription that builds the ordered live parts (and, from them,
    // tool names / live text / reasoning / images / activity) for the turn
    // currently streaming — replaces the four separate trackers. Tool names
    // resolve once per call (not per token), so onUpdate here is cheap; a
    // committed turn whose tool "call" part failed to persist (CL-1398)
    // still renders the real name instead of a generic "Tool call".
    assemblerRef.current = createPartAssembler(
      transport,
      { tenantId, instanceId },
      () => {
        if (!cancelled) forceUpdate((n) => n + 1);
      },
    );

    if (!cancelled) setSessionState({ phase: "ready", session });

    return () => {
      cancelled = true;
      stopRef.current?.();
      stopRef.current = null;
      assemblerRef.current?.stop();
      assemblerRef.current = null;
      sessionRef.current?.destroy();
      sessionRef.current = null;
      const urls = attachmentUrlsRef.current;
      attachmentUrlsRef.current = new Map();
      for (const pending of urls.values()) {
        void pending.then(URL.revokeObjectURL).catch(() => {});
      }
    };
  }, [instanceId, tenantId, launchStatus]);

  const resolveAttachmentUrl = useCallback(
    (blobId: string): Promise<string> => {
      const cache = attachmentUrlsRef.current;
      const existing = cache.get(blobId);
      if (existing !== undefined) return existing;
      const pending = fetchBlobObjectUrl(tenantId, blobId).catch((err) => {
        cache.delete(blobId);
        throw err;
      });
      cache.set(blobId, pending);
      return pending;
    },
    [tenantId],
  );

  function buildMessages(session: InstanceSession): ChatMessage[] {
    const assembler = assemblerRef.current;
    const { messages } = composeChatMessages({
      events: session.events,
      streaming: assembler !== null ? assembler.text : "",
      reasoning: assembler !== null ? assembler.reasoning : "",
      ...(assembler !== null ? { toolNames: assembler.toolNames } : {}),
      ...(assembler !== null && assembler.liveImages.length > 0
        ? { liveImages: assembler.liveImages }
        : {}),
      ...(assembler !== null ? { liveParts: assembler.parts } : {}),
    });
    return messages;
  }

  if (sessionState.phase === "loading") {
    return (
      <ChatPanel
        agent={identity}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={
          <span className="text-[13px] text-text-3">
            Connecting to {agentName}...
          </span>
        }
        onClose={onClose}
      />
    );
  }

  if (sessionState.phase === "pending") {
    const copy =
      sessionState.reason === "deploying"
        ? `${agentName} is still starting up. This usually takes a few seconds.`
        : `Waiting for ${agentName} to become available...`;
    return (
      <ChatPanel
        agent={identity}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={<span className="text-[13px] text-text-3">{copy}</span>}
        onClose={onClose}
      />
    );
  }

  if (sessionState.phase === "missing-config") {
    return (
      <ChatPanel
        agent={identity}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={
          <span className="text-[13px] text-text-2">
            {agentName} needs a credential before it can start.{" "}
            {onConfigureAgent ? (
              <button className="underline" onClick={onConfigureAgent}>
                Configure the agent
              </button>
            ) : (
              "Add a credential in Settings to continue."
            )}
          </span>
        }
        onClose={onClose}
      />
    );
  }

  if (sessionState.phase === "error") {
    return (
      <ChatPanel
        agent={identity}
        messages={[]}
        onSend={() => undefined}
        inputDisabled
        notice={
          <span className="text-[13px] text-text-2">
            {agentName} could not be reached.{" "}
            <button
              className="underline"
              onClick={() => {
                setSessionState({ phase: "loading" });
                launch();
              }}
            >
              Try again
            </button>
          </span>
        }
        onClose={onClose}
      />
    );
  }

  const { session } = sessionState;
  const messages = buildMessages(session);

  // Live activity is derived from the assembler's trailing open part — the
  // single owner of "what is the agent doing right now." rate_limited stays
  // on the session's own status channel, never folded into parts, and it
  // wins over the assembler's derived state: retries happen mid-inference,
  // when the assembler still reports "thinking", and the retry countdown
  // must surface.
  let activity: ChatActivity | null = null;
  if (session.activity?.type === "rate_limited") {
    activity = session.activity;
  } else if (assemblerRef.current !== null) {
    activity = assemblerRef.current.activity;
  }

  const sendText = (text: string) => {
    void session.sendMail(text).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setSessionState({ phase: "error", message });
    });
  };

  const handleBlockAction = (
    action: "copy" | "download" | "save-artifact",
    block: UIBlock,
  ) => {
    if (block.kind !== "document") return;
    if (action === "copy") {
      void navigator.clipboard
        .writeText(block.source)
        .then(() => flashActionNotice("Copied to clipboard."))
        .catch(() =>
          flashActionNotice("Couldn't copy to clipboard.", "failure"),
        );
      return;
    }
    if (action === "download") {
      downloadMarkdown(block.title, block.source);
      return;
    }
    saveDocumentArtifact(block);
  };

  return (
    <ChatPanel
      agent={identity}
      messages={messages}
      onSend={sendText}
      onAbort={abortTurn}
      // Structured gate blocks (form/multiSelect/choice payload) need
      // resolveResumePayload + workflow resume — see docs/WORKFLOWS.md.
      onRespond={(response: UIResponse) => sendText(response.value)}
      onAction={handleBlockAction}
      {...(actionNotice !== null
        ? {
            notice: (
              <span className="flex items-center gap-2 text-[13px] text-text-2">
                <span className="min-w-0 flex-1">{actionNotice.text}</span>
                {actionNotice.variant === "failure" && (
                  <button
                    type="button"
                    onClick={dismissActionNotice}
                    className="shrink-0 rounded-md px-2 py-0.5 text-xs text-text-2 underline hover:text-text cursor-pointer"
                  >
                    Dismiss
                  </button>
                )}
              </span>
            ),
          }
        : {})}
      activity={activity}
      onClose={onClose}
      onRate={(subjectId, subjectKind, rating) =>
        rateMutateAsync({ subjectId, subjectKind, rating }).catch(() => {})
      }
      getRating={(subjectId: string, subjectKind: FeedbackSubjectKind) =>
        ratingsMap.get(`${subjectId}:${subjectKind}`) ?? null
      }
      resolveAttachmentUrl={resolveAttachmentUrl}
      formatToolSummary={formatToolSummary}
      formatToolResult={friendlyToolResult}
      formatToolName={(name) => friendlyToolSummary({ id: "", name })}
      compactToolActivity={compactToolActivity}
      summarizeToolCalls={summarize}
      isQuietTool={isCatalogMetaTool}
      isExternalTool={isExternalIntegrationTool}
      renderToolMarker={renderChatToolMarker}
    />
  );
}
