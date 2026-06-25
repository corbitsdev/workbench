import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Link, useNavigate, useParams } from "react-router";
import {
  ArrowLeft,
  ChevronDown,
  Loader2,
  Maximize2,
  PanelBottom,
  Send,
} from "lucide-react";
import { useArtifacts } from "@workbench/client/react";
import type { ArtifactWithSession } from "@workbench/artifact";
import { clientOptions } from "../lib/client-options";
import ArtifactBody from "../components/ArtifactBody";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { MyraChatSurface } from "../components/MyraChatSurface";
import { resolveKindLabel } from "../lib/resolve-kind-label";
import { buildArtifactMessage } from "../components/layout/ArtifactGallery";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { useChatLauncher } from "../lib/chat-launcher-context";
import { useMyraSession } from "../hooks/use-myra-session";
import {
  isDefaultThreadLabel,
  useCreateMyraThread,
  useGenerateMyraThreadTitle,
  writeLastActiveThreadId,
} from "../hooks/use-myra-threads";
import type { MyraThread } from "../lib/hub-api";
import {
  setPendingFirstMessage,
  takePendingFirstMessage,
} from "../lib/pending-first-message";

// Shared easing (matches the --ease design token) so the in-pane motion reads
// like the same family as FloatingChat / DockedChatBar.
const EASE = [0.22, 0.61, 0.36, 1] as const;

function CenteredNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center text-sm text-text-2">
      {children}
    </div>
  );
}

/**
 * "Open in" menu — moves the live conversation to a full-page chat or the dock.
 * Origin-aware scale-in from the trigger, full keyboard support (Escape returns
 * focus, arrows move between items), and focus on open.
 */
type MenuAnchor = { top: number; right: number };

function OpenInMenu({
  onFullScreen,
  onDock,
}: {
  onFullScreen: () => void;
  onDock: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const reduceMotion = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Focus the first item when the menu opens so it is keyboard-operable.
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
  }, [open]);

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect)
      setAnchor({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    setOpen(true);
  };

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ) ?? [],
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? idx + 1 : idx - 1;
    items[(next + items.length) % items.length]?.focus();
  };

  const itemClass =
    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text outline-none transition-colors hover:bg-page focus-visible:bg-page";

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close(false) : openMenu())}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-text-2 outline-none transition-[color,background-color,transform] hover:bg-page hover:text-text focus-visible:ring-2 focus-visible:ring-orange active:scale-[0.97]"
      >
        Open in
        <ChevronDown
          size={14}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && anchor && (
            <>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                className="fixed inset-0 z-[60] cursor-default"
                onClick={() => close(false)}
              />
              <motion.div
                ref={menuRef}
                role="menu"
                onKeyDown={onMenuKeyDown}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={
                  reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }
                }
                transition={{ duration: 0.15, ease: EASE }}
                style={{
                  top: anchor.top,
                  right: anchor.right,
                  transformOrigin: "top right",
                }}
                className="fixed z-[61] w-44 overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close(false);
                    onFullScreen();
                  }}
                  className={itemClass}
                >
                  <Maximize2 size={15} className="text-text-2" />
                  Full screen
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close(false);
                    onDock();
                  }}
                  className={itemClass}
                >
                  <PanelBottom size={15} className="text-text-2" />
                  Dock
                </button>
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

/**
 * Full-page view of a single artifact: type-adaptive render (ArtifactBody) on
 * the left, a live Myra chat on the right. The first message lazily creates a
 * Myra thread seeded with this artifact as context and the conversation renders
 * in place — no navigation away. "Open in" hands the thread to a full-page chat
 * or the global dock.
 */
export function ArtifactDetailPage() {
  const { artifactId } = useParams();
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const { activeTenantId } = useActiveWorkbench();
  const { openThreadInDock } = useChatLauncher();
  const createThread = useCreateMyraThread();
  const generateTitle = useGenerateMyraThreadTitle();
  const [draft, setDraft] = useState("");
  const [thread, setThread] = useState<MyraThread | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const session = useMyraSession(thread?.instanceId ?? null, thread !== null);

  const {
    data: artifacts,
    isLoading,
    isError,
  } = useArtifacts(clientOptions, {
    tenantId: activeTenantId,
    enabled: !!activeTenantId,
  });

  const artifact: ArtifactWithSession | null =
    (artifacts ?? []).find((a) => a.id === artifactId) ?? null;

  // Grow the composer with its content (caps at ~6 lines via max-height).
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  // Deliver the seeded first message once the freshly-created thread's session
  // is ready. Mirrors ChatThreadPage's deliver-once handoff.
  const deliveredRef = useRef<string | null>(null);
  useEffect(() => {
    if (session.state.phase !== "ready" || !thread) return;
    if (deliveredRef.current === thread.id) return;
    const pending = takePendingFirstMessage(thread.id);
    if (pending) {
      deliveredRef.current = thread.id;
      session.send(pending);
    }
    // session.send is recreated each render; gate on phase + thread id instead.
  }, [session.state.phase, thread]);

  const startThread = () => {
    const text = draft.trim();
    if (!text || !artifact || createThread.isPending) return;
    createThread.mutate(undefined, {
      onSuccess: (created) => {
        const seeded = `${buildArtifactMessage(artifact, activeTenantId ?? undefined)}\n\n${text}`;
        setPendingFirstMessage(created.id, seeded);
        writeLastActiveThreadId(created.id);
        if (isDefaultThreadLabel(created.label)) {
          generateTitle.mutate({ id: created.id, firstMessage: text });
        }
        setDraft("");
        setThread(created);
      },
    });
  };

  const openFullScreen = () => {
    if (!thread) return;
    const id = thread.id;
    // Release the in-pane session before the full-page chat claims the instance.
    setThread(null);
    deliveredRef.current = null;
    navigate(`/chats/${id}`);
  };

  const openInDock = () => {
    if (!thread) return;
    openThreadInDock(thread.id);
    // Tear down the in-pane session so the dock owns the single live surface.
    setThread(null);
    deliveredRef.current = null;
  };

  if (isLoading) return <CenteredNotice>Loading artifact…</CenteredNotice>;

  if (isError || !artifact) {
    return (
      <CenteredNotice>
        <div className="flex flex-col items-center gap-2">
          <span>This artifact couldn't be found.</span>
          <Link to="/artifacts" className="text-orange underline">
            Back to artifacts
          </Link>
        </div>
      </CenteredNotice>
    );
  }

  const fade = {
    initial: reduceMotion ? false : { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 },
    transition: { duration: 0.18, ease: EASE },
  };

  return (
    <div className="flex h-full flex-col overflow-hidden lg:flex-row">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <button
            type="button"
            onClick={() => navigate("/artifacts")}
            aria-label="Back to artifacts"
            className="grid h-8 w-8 place-items-center rounded-sm text-text-2 outline-none transition-[color,background-color,transform] hover:bg-page hover:text-text focus-visible:ring-2 focus-visible:ring-orange active:scale-[0.97]"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-text">
              {artifact.title}
            </h1>
            <p className="text-xs text-text-3">
              {resolveKindLabel(artifact.kind)}
            </p>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
          <ErrorBoundary>
            <ArtifactBody artifact={artifact} />
          </ErrorBoundary>
        </div>
      </div>

      <div className="flex shrink-0 flex-col overflow-hidden border-t border-border lg:w-[360px] lg:border-l lg:border-t-0">
        <AnimatePresence mode="wait" initial={false}>
          {thread ? (
            <motion.div
              key="chat"
              {...fade}
              className="flex min-h-0 flex-1 flex-col"
            >
              {/* Slim action bar — Myra's identity comes from the chat header
                  below, so this carries only the "Open in" affordance. */}
              <div className="flex shrink-0 items-center justify-end px-2 py-1">
                <OpenInMenu onFullScreen={openFullScreen} onDock={openInDock} />
              </div>
              <div className="min-h-0 flex-1">
                <ErrorBoundary>
                  <MyraChatSurface
                    session={session}
                    threadLabel={thread.label}
                  />
                </ErrorBoundary>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="composer"
              {...fade}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-text">
                  Ask about this artifact
                </h2>
                <p className="text-xs text-text-3">
                  Start a chat with this artifact as context.
                </p>
              </div>
              <div className="min-h-0 flex-1" />
              <div className="border-t border-border p-3">
                <div className="flex items-end gap-2 rounded-lg border border-border bg-surface p-2 transition-colors focus-within:border-orange focus-within:ring-2 focus-within:ring-orange/40">
                  <textarea
                    ref={composerRef}
                    value={draft}
                    autoFocus
                    disabled={createThread.isPending}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        startThread();
                      }
                    }}
                    rows={2}
                    aria-label="Ask Myra about this artifact"
                    placeholder="Ask Myra about this artifact…"
                    className="max-h-36 min-h-0 flex-1 resize-none overflow-y-auto bg-transparent text-sm text-text outline-none placeholder:text-text-3 disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={startThread}
                    disabled={draft.trim() === "" || createThread.isPending}
                    aria-label={
                      createThread.isPending ? "Starting chat" : "Start chat"
                    }
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-orange text-white outline-none transition-[opacity,transform] hover:opacity-90 focus-visible:ring-2 focus-visible:ring-orange active:scale-[0.94] disabled:opacity-40"
                  >
                    {createThread.isPending ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <Send size={15} />
                    )}
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
