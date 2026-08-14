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
  type ProfileCardAction,
} from "@corbits/react-ui";
import { ArtifactRenderer } from "@corbits/artifact-ui";
import type { ProfileSubject } from "@corbits/chat-ui";
import { Maximize2, Minimize2, UserRound, X } from "lucide-react";
import type { CanvasArtifactContent } from "./canvas-column-state";

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
  onClose: () => void,
  onNavigate: (path: string) => void,
): readonly ProfileCardAction[] {
  if (profile.kind === "agent") {
    return [
      {
        id: "message",
        label: "Message",
        tone: "primary",
        onClick: onClose,
      },
      {
        id: "mention",
        label: "Mention",
        tone: "outline",
        onClick: onClose,
      },
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
      {
        id: "pause",
        label: "Pause",
        tone: "outline",
        onClick: onClose,
      },
    ];
  }

  return [
    {
      id: "message",
      label: "Message",
      tone: "primary",
      onClick: onClose,
    },
    {
      id: "mention",
      label: "Mention",
      tone: "outline",
      onClick: onClose,
    },
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
        actions={profileActions(profile, onClose, onNavigate)}
      />
      <p className="shell-profile-pane-hint">
        Shared channels and pinned skills land here when the host has them.
      </p>
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
