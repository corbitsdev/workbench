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
  toast,
  type ProfileCardAction,
  type ProfileCardChannel,
} from "@corbits/react-ui";
import type { ProfileSubject, SharedChannelSummary } from "@corbits/chat-ui";
import { UserRound, X } from "lucide-react";
import { useEffect, useState } from "react";

import { useBench } from "../bench-context";
import { channelPath } from "../channel-path";
import { ensureProfileDm, loadSharedChannels } from "../profile-relations";
import { useInsertIntoComposer } from "./composer-insertion";

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

/**
 * Open-or-create the DM with `profile` and land on it. `tenantId === null`
 * (bench not resolved yet) has nothing to message against — the button
 * stays present but no-ops rather than crashing.
 */
function messageAction(
  tenantId: string | null,
  profile: ProfileSubject,
  onNavigate: (path: string) => void,
): () => void {
  return () => {
    if (tenantId === null) return;
    void ensureProfileDm(tenantId, profile).then((result) => {
      if (result.kind === "ready") {
        onNavigate(channelPath(result.channelId));
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

function profileActions(
  profile: ProfileSubject,
  tenantId: string | null,
  onClose: () => void,
  onNavigate: (path: string) => void,
  insertIntoComposer: (text: string) => boolean,
): readonly ProfileCardAction[] {
  const message: ProfileCardAction = {
    id: "message",
    label: "Message",
    tone: "primary",
    onClick: () => {
      messageAction(tenantId, profile, onNavigate)();
      onClose();
    },
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
  onClose,
  onNavigate,
}: {
  readonly profile: ProfileSubject;
  readonly onClose: () => void;
  readonly onNavigate: (path: string) => void;
}) {
  const { selectedTenantId, selectedPrincipalId } = useBench();
  const insertIntoComposer = useInsertIntoComposer();
  const sharedChannels = useSharedChannels(
    selectedTenantId,
    selectedPrincipalId,
    profile,
  );

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
        actions={profileActions(
          profile,
          selectedTenantId,
          onClose,
          onNavigate,
          insertIntoComposer,
        )}
        sharedChannels={toProfileCardChannels(sharedChannels)}
      />
    </div>
  );
}
