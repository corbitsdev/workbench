// Column 4: the optional canvas. Collapsed, it takes no space at all — the
// main pane gets the width back — and open, it hosts targeted auxiliary
// content: profile cards, and (CL-5938) typed artifact renderers opened
// from a chat artifact chip or the Library page. Primary channel
// conversation lives in the main stage, not here.
//
// Read-only phase: the artifact pane has no editing affordances yet — the
// multiplayer-editing half is CL-5958's substrate to build on top of this.
//
// The collapse/expand motion lives entirely in `shell.css` as a CSS
// transition on `transform`/`opacity` (plus width, so the main pane
// actually reflows) triggered by the `data-open` attribute — never a JS
// animation — so rapid toggling is inherently interruptible: the browser
// just reverses whichever transition is already in flight, there is no
// queue to get stuck. `prefers-reduced-motion` is handled the same way, in
// CSS, by shortening the transition to near-zero.

import {
  Button,
  EmptyState,
  ProfileCard,
  toast,
  type ProfileCardAction,
  type ProfileCardChannel,
} from "@corbits/react-ui";
import { ArtifactRenderer } from "@corbits/artifact-ui";
import type { ProfileSubject, SharedChannelSummary } from "@corbits/chat-ui";
import { Maximize2, Minimize2, UserRound, X } from "lucide-react";
import { useEffect, useState } from "react";

import { useBench } from "../bench-context";
import { channelPath } from "../channel-path";
import { ensureProfileDm, loadSharedChannels } from "../profile-relations";
import type { CanvasArtifactContent } from "./canvas-column-state";
import { useInsertIntoComposer } from "./composer-insertion";

export function CanvasColumn({
  open,
  profile,
  artifact,
  focus,
  onClose,
  onToggleFocus,
  onNavigate,
}: {
  readonly open: boolean;
  readonly profile: ProfileSubject | null;
  readonly artifact: CanvasArtifactContent | null;
  readonly focus: boolean;
  readonly onClose: () => void;
  readonly onToggleFocus: () => void;
  readonly onNavigate: (path: string) => void;
}) {
  // `inert` rather than `aria-hidden`: a collapsed column has to be out of
  // both the accessibility tree and the tab order, and `aria-hidden` alone
  // only does the first — a focusable descendant inside an `aria-hidden`
  // subtree is an ARIA violation, and the browser moves focus out of an
  // `inert` subtree for us when it closes.
  return (
    <div
      className="shell-canvas-column"
      data-open={open}
      data-focus={focus}
      inert={!open}
    >
      <div className="shell-canvas-inner">
        {profile !== null ? (
          <ProfileCanvasPane
            profile={profile}
            focus={focus}
            onClose={onClose}
            onToggleFocus={onToggleFocus}
            onNavigate={onNavigate}
          />
        ) : artifact !== null ? (
          <ArtifactCanvasPane
            artifact={artifact}
            focus={focus}
            onClose={onClose}
            onToggleFocus={onToggleFocus}
          />
        ) : (
          <EmptyState
            icon={<UserRound />}
            title="Nothing open"
            description="Profiles and artifacts open here when you need them."
          />
        )}
      </div>
    </div>
  );
}

/**
 * Open-or-create the DM with `profile` and land on it. `tenantId === null`
 * (bench not resolved yet) has nothing to message against — an honest toast,
 * matching `mentionAction`'s pattern, rather than a silent no-op. The panel
 * only closes once the DM is actually resolved: `setPending` drives the
 * button's in-flight label so a slow create isn't mistaken for nothing
 * having happened.
 */
function messageAction(
  tenantId: string | null,
  profile: ProfileSubject,
  onNavigate: (path: string) => void,
  onClose: () => void,
  setPending: (pending: boolean) => void,
): () => void {
  return () => {
    if (tenantId === null) {
      toast(`Open a bench to message @${profile.handle}`);
      return;
    }
    setPending(true);
    void ensureProfileDm(tenantId, profile).then((result) => {
      setPending(false);
      if (result.kind === "ready") {
        onNavigate(channelPath(result.channelId));
        onClose();
      } else {
        toast(result.message);
      }
    });
  };
}

/** Insert `@handle` into whichever channel's composer is on screen — an
 * honest "nothing to mention into" toast when none is (CL-5914: no channel
 * open, or the settings surface is showing instead of a conversation). */
function mentionAction(
  profile: ProfileSubject,
  insertIntoComposer: (text: string) => boolean,
): () => void {
  return () => {
    const inserted = insertIntoComposer(`@${profile.handle} `);
    if (!inserted) {
      toast(`Open a channel to mention @${profile.handle}`);
    }
  };
}

/** Shared header row for every canvas pane: an optional title, the mock's
 * focus-cycle control (`data-action="canvas-focus"`), and its explicit
 * close (`data-action="canvas-close"`) — one row, every content type. */
function CanvasPaneHeader({
  title,
  focus,
  onClose,
  onToggleFocus,
}: {
  readonly title?: string;
  readonly focus: boolean;
  readonly onClose: () => void;
  readonly onToggleFocus: () => void;
}) {
  return (
    <div className="shell-canvas-pane-header">
      {title !== undefined ? (
        <span className="shell-canvas-pane-title">{title}</span>
      ) : null}
      <div className="shell-canvas-pane-actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleFocus}
          aria-label={focus ? "Exit focus" : "Focus"}
          title={focus ? "Exit focus" : "Focus"}
        >
          {focus ? <Minimize2 /> : <Maximize2 />}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
          <X />
        </Button>
      </div>
    </div>
  );
}

function profileActions(
  profile: ProfileSubject,
  tenantId: string | null,
  onClose: () => void,
  onNavigate: (path: string) => void,
  insertIntoComposer: (text: string) => boolean,
  messagePending: boolean,
  setMessagePending: (pending: boolean) => void,
): readonly ProfileCardAction[] {
  const message: ProfileCardAction = {
    id: "message",
    label: messagePending ? "Messaging…" : "Message",
    tone: "primary",
    onClick: messageAction(
      tenantId,
      profile,
      onNavigate,
      onClose,
      setMessagePending,
    ),
  };
  const mention: ProfileCardAction = {
    id: "mention",
    label: "Mention",
    tone: "outline",
    onClick: () => {
      mentionAction(profile, insertIntoComposer)();
      onClose();
    },
  };

  // Pause has no backing API today (CL-5884 follow-up: no workflow-run
  // pause endpoint exists anywhere in the hub) — omitted rather than left
  // as a no-op that pretends to do something.
  if (profile.kind === "agent") {
    return [
      message,
      mention,
      {
        id: "edit-agent",
        label: "Edit agent",
        tone: "outline",
        onClick: () => {
          onClose();
          onNavigate("/settings/agents");
        },
      },
      {
        id: "view-runs",
        label: "View runs",
        tone: "outline",
        onClick: () => {
          onClose();
          onNavigate("/insights");
        },
      },
    ];
  }

  return [
    message,
    mention,
    {
      id: "view-activity",
      label: "View activity",
      tone: "outline",
      onClick: () => {
        onClose();
        onNavigate("/insights");
      },
    },
    {
      id: "grants",
      label: "Grants",
      tone: "outline",
      onClick: () => {
        onClose();
        onNavigate("/settings");
      },
    },
  ];
}

function toProfileCardChannels(
  channels: readonly SharedChannelSummary[],
): readonly ProfileCardChannel[] {
  return channels.map((channel) => ({
    id: channel.id,
    name: channel.title,
    href: channelPath(channel.id),
  }));
}

/** Shared channels between the viewer and `profile` (CL-5919) — refetched
 * whenever the open profile changes, dropped if a later change races past
 * an in-flight fetch. Pinned skills are intentionally never populated: no
 * agent carries any real skill-attachment data yet (tracked in CL-5991), so
 * showing them would be fabricated, not deferred. */
function useSharedChannels(
  tenantId: string | null,
  viewerPrincipalId: string | null,
  profile: ProfileSubject,
): readonly SharedChannelSummary[] {
  const [channels, setChannels] = useState<readonly SharedChannelSummary[]>([]);

  useEffect(() => {
    setChannels([]);
    if (tenantId === null || viewerPrincipalId === null) return;
    let cancelled = false;
    void loadSharedChannels(tenantId, viewerPrincipalId, profile).then(
      (result) => {
        if (!cancelled) setChannels(result);
      },
      () => {
        if (!cancelled) setChannels([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tenantId, viewerPrincipalId, profile.address]);

  return channels;
}

function ProfileCanvasPane({
  profile,
  focus,
  onClose,
  onToggleFocus,
  onNavigate,
}: {
  readonly profile: ProfileSubject;
  readonly focus: boolean;
  readonly onClose: () => void;
  readonly onToggleFocus: () => void;
  readonly onNavigate: (path: string) => void;
}) {
  const { selectedTenantId, selectedPrincipalId } = useBench();
  const insertIntoComposer = useInsertIntoComposer();
  const [messagePending, setMessagePending] = useState(false);
  // A new subject means any in-flight "Messaging…" belonged to the last one.
  useEffect(() => {
    setMessagePending(false);
  }, [profile.address]);
  const sharedChannels = useSharedChannels(
    selectedTenantId,
    selectedPrincipalId,
    profile,
  );

  return (
    <div className="shell-profile-pane">
      <CanvasPaneHeader
        focus={focus}
        onClose={onClose}
        onToggleFocus={onToggleFocus}
      />
      <ProfileCard
        name={profile.displayName}
        subtitle={`@${profile.handle}`}
        initials={profile.initials}
        statusLabel={profile.kind === "agent" ? "Agent" : "Member"}
        avatarTone={profile.kind === "agent" ? "agent" : "neutral"}
        actions={profileActions(
          profile,
          selectedTenantId,
          onClose,
          onNavigate,
          insertIntoComposer,
          messagePending,
          setMessagePending,
        )}
        sharedChannels={toProfileCardChannels(sharedChannels)}
      />
    </div>
  );
}

function ArtifactCanvasPane({
  artifact,
  focus,
  onClose,
  onToggleFocus,
}: {
  readonly artifact: CanvasArtifactContent;
  readonly focus: boolean;
  readonly onClose: () => void;
  readonly onToggleFocus: () => void;
}) {
  return (
    <div className="shell-artifact-pane">
      <CanvasPaneHeader
        title={artifact.title}
        focus={focus}
        onClose={onClose}
        onToggleFocus={onToggleFocus}
      />
      <div className="shell-artifact-pane-body">
        <ArtifactRenderer
          rendererKind={artifact.rendererKind}
          title={artifact.title}
          content={artifact.content}
          {...(artifact.unavailableReason !== undefined
            ? { unavailableReason: artifact.unavailableReason }
            : {})}
        />
      </div>
    </div>
  );
}
