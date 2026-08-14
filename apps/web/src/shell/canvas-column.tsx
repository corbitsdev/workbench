// Column 4: the optional canvas. Collapsed, it takes no space at all — the
// main pane gets the width back — and open, it hosts targeted auxiliary
// content (profile cards today). Primary channel conversation lives in the
// main stage, not here.
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
import type { ProfileSubject } from "@corbits/chat-ui";
import { UserRound, X } from "lucide-react";

export function CanvasColumn({
  open,
  profile,
  onCloseProfile,
  onNavigate,
}: {
  readonly open: boolean;
  readonly profile: ProfileSubject | null;
  readonly onCloseProfile: () => void;
  readonly onNavigate: (path: string) => void;
}) {
  // `inert` rather than `aria-hidden`: a collapsed column has to be out of
  // both the accessibility tree and the tab order, and `aria-hidden` alone
  // only does the first — a focusable descendant inside an `aria-hidden`
  // subtree is an ARIA violation, and the browser moves focus out of an
  // `inert` subtree for us when it closes.
  return (
    <div className="shell-canvas-column" data-open={open} inert={!open}>
      <div className="shell-canvas-inner">
        {profile !== null ? (
          <ProfileCanvasPane
            profile={profile}
            onClose={onCloseProfile}
            onNavigate={onNavigate}
          />
        ) : (
          <EmptyState
            icon={<UserRound />}
            title="Nothing open"
            description="Profiles and other details open here when you need them."
          />
        )}
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
  onClose,
  onNavigate,
}: {
  readonly profile: ProfileSubject;
  readonly onClose: () => void;
  readonly onNavigate: (path: string) => void;
}) {
  return (
    <div className="shell-profile-pane">
      <div className="shell-profile-pane-header">
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close profile"
        >
          <X />
        </Button>
      </div>
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
