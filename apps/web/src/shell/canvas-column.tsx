// Column 4: the optional canvas. Collapsed, it takes no space at all — the
// main pane gets the width back — and open, it hosts the channel chat
// surface (the retired `/chat` page's `ChatWorkspace`) and, when a profile
// subject is set, a ProfileCard overlay for that member or agent.
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
import { ChatWorkspace, type ProfileSubject } from "@corbits/chat-ui";
import {
  LayoutPanelLeft,
  MessageSquare,
  PanelRightClose,
  X,
} from "lucide-react";

import { useBench } from "../bench-context";
import { tenantResolutionFromBench } from "./tenant-resolution";

export function CanvasToggle({
  open,
  onToggle,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggle}
      aria-pressed={open}
      aria-label={open ? "Hide canvas" : "Show canvas"}
      title={open ? "Hide canvas" : "Show canvas"}
    >
      {open ? <PanelRightClose /> : <LayoutPanelLeft />}
    </Button>
  );
}

export function CanvasColumn({
  open,
  channelId,
  profile,
  onChannelChange,
  onOpenProfile,
  onCloseProfile,
  onNavigate,
}: {
  readonly open: boolean;
  readonly channelId: string | null;
  readonly profile: ProfileSubject | null;
  readonly onChannelChange: (channelId: string) => void;
  readonly onOpenProfile: (subject: ProfileSubject) => void;
  readonly onCloseProfile: () => void;
  readonly onNavigate: (path: string) => void;
}) {
  const bench = useBench();
  const tenant = tenantResolutionFromBench(bench);
  const principalId = bench.selectedPrincipalId ?? undefined;

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
        ) : channelId === null ? (
          <EmptyState
            icon={<MessageSquare />}
            title="No channel open"
            description="Pick a channel from the panel, or open one from Agents or the command palette."
          />
        ) : (
          <ChatWorkspace
            tenant={tenant}
            channelId={channelId}
            onChannelChange={onChannelChange}
            onOpenProfile={onOpenProfile}
            {...(principalId !== undefined
              ? { currentUser: { principalId } }
              : {})}
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
          onNavigate("/agents");
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
