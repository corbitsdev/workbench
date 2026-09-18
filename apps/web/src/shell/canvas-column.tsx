// Collapse/expand is a CSS transition on `data-open`, never JS animation,
// so rapid toggling is inherently interruptible — no queue to get stuck.

// No co-edit presence: a "doc"-kind artifact is a plain single-user
// textarea. That capability, if it returns, lives on `@corbits/presence`.

import {
  Button,
  EmptyState,
  ProfileCard,
  toast,
  type ProfileCardAction,
  // vendor noun: channel — @corbits/react-ui's own `ProfileCardChannel`,
  // published from a separate repo, not part of this rename.
  type ProfileCardChannel,
} from "@corbits/react-ui";
import { ArtifactRenderer, ArtifactTextEditor, type ArtifactSaveState } from "@/library";
import type { ProfileSubject } from "@/chat";
import { ArrowsIn, ArrowsOut, ArrowSquareOut, CaretLeft, UserCircle, X } from "@/lib/icons";
import type { ReactNode } from "react";

import { useBench } from "../bench-context";
import { NEW_CHAT_PATH } from "../chat-path";
import type { CanvasArtifactContent, RoutinePanelSubject } from "./canvas-availability";
import { useInsertIntoComposer } from "./composer-insertion";

export function CanvasColumn({
  open,
  profile,
  artifact,
  focus,
  onClose,
  onToggleFocus,
  onNavigate,
  artifactSaveState,
  onSaveArtifact,
}: {
  readonly open: boolean;
  readonly profile: ProfileSubject | null;
  readonly artifact: CanvasArtifactContent | null;
  readonly routine: RoutinePanelSubject | null;
  readonly focus: boolean;
  readonly onClose: () => void;
  readonly onToggleFocus: () => void;
  readonly onNavigate: (path: string) => void;
  /** The honest save-state line for an editable "doc"-kind `artifact` — see `ArtifactSaveState`. */
  readonly artifactSaveState?: ArtifactSaveState;
  /** Fired (debounced) with the editor's full current text — the host's
   * one seam to the artifacts PUT route. Absent for a non-editable artifact. */
  readonly onSaveArtifact?: (content: string) => void;
}) {
  // `inert`, not `aria-hidden` alone: `aria-hidden` doesn't remove a
  // focusable descendant from the tab order.
  return (
    <div className="shell-canvas-column" data-open={open} data-focus={focus} inert={!open}>
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
            {...(artifactSaveState !== undefined ? { artifactSaveState } : {})}
            {...(onSaveArtifact !== undefined ? { onSaveArtifact } : {})}
          />
        ) : (
          <EmptyState
            icon={<UserCircle />}
            title="Nothing open"
            description="Profiles and artifacts open here when you need them."
          />
        )}
      </div>
    </div>
  );
}

/** Messaging someone is composing a chat thread with them: land on the
 * composer rather than minting anything here. */
function messageAction(
  tenantId: string | null,
  profile: ProfileSubject,
  onNavigate: (path: string) => void,
  onClose: () => void,
): () => void {
  return () => {
    if (tenantId === null) {
      toast(`Open a workbench to message @${profile.handle}`);
      return;
    }
    // A DM is a chat thread now: compose it on /chats/new.
    onNavigate(NEW_CHAT_PATH);
    onClose();
  };
}

/** Insert `@handle` into whichever workbench's composer is on screen — an
 * honest "nothing to mention into" toast when none is (: no workbench
 * open, or the settings surface is showing instead of a conversation). */
function mentionAction(
  profile: ProfileSubject,
  insertIntoComposer: (text: string) => boolean,
): () => void {
  return () => {
    const inserted = insertIntoComposer(`@${profile.handle} `);
    if (!inserted) {
      toast(`Open a conversation to mention @${profile.handle}`);
    }
  };
}

/** Shared header row for every canvas pane: an optional leading back
 * control, an optional title, an optional pane-specific `trailing` slot,
 * and — for the panes that use them — the mock's focus-cycle control and
 * its explicit close. `onBack` and the focus/close controls are mutually
 * exclusive in practice (a pane is either master-detail-driven, like the
 * routine pane, or focus/close-driven, like profile and artifact), but
 * both are optional so this one component covers every canvas pane's
 * header rather than each pane hand-rolling its own. */
export function CanvasPaneHeader({
  title,
  onBack,
  focus,
  onClose,
  onToggleFocus,
  previewSrc,
  trailing,
  className,
}: {
  readonly title?: string;
  /** Present for the routine pane's master-detail chrome: a back chevron
   * in place of the focus/close controls profile and artifact use. */
  readonly onBack?: () => void;
  readonly focus?: boolean;
  readonly onClose?: () => void;
  readonly onToggleFocus?: () => void;
  /** When set (an `"html"`-kind artifact with a resolved preview route),
   * adds an "Open in new tab" action pointed at the same sandboxed URL the
   * pane's iframe already loads. */
  readonly previewSrc?: string;
  /** Extra trailing content specific to one pane (the routine list's
   * "Runs" shortcut, or the editor's save-state label), rendered before
   * any shared focus/close controls. */
  readonly trailing?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={
        className === undefined
          ? "shell-canvas-pane-header"
          : `shell-canvas-pane-header ${className}`
      }
    >
      <div className="shell-canvas-pane-heading">
        {onBack !== undefined ? (
          <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back" title="Back">
            <CaretLeft />
          </Button>
        ) : null}
        {title !== undefined ? <span className="shell-canvas-pane-title">{title}</span> : null}
      </div>
      <div className="shell-canvas-pane-actions">
        {trailing}
        {previewSrc !== undefined ? (
          <Button variant="ghost" size="sm" asChild>
            <a href={previewSrc} target="_blank" rel="noreferrer">
              <ArrowSquareOut aria-hidden="true" />
              Open in new tab
            </a>
          </Button>
        ) : null}
        {onToggleFocus !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleFocus}
            aria-label={focus === true ? "Exit focus" : "Focus"}
            title={focus === true ? "Exit focus" : "Focus"}
          >
            {focus === true ? <ArrowsIn /> : <ArrowsOut />}
          </Button>
        ) : null}
        {onClose !== undefined ? (
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        ) : null}
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
): readonly ProfileCardAction[] {
  const message: ProfileCardAction = {
    id: "message",
    label: "Message",
    tone: "primary",
    onClick: messageAction(tenantId, profile, onNavigate, onClose),
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

  // Pause has no backing API today (follow-up: no workflow-run
  // pause endpoint exists anywhere in the hub) — omitted rather than left
  // as a no-op that pretends to do something.
  if (profile.kind === "agent") {
    // No "Edit agent" hop here: `ProfileSubject` (chat-ui's
    // `profile-subject.ts`) carries only address/handle/displayName, never
    // a workbench id, so this card has no way to resolve the agent's own
    // workbench settings. The global `/settings/agents` tab this used to
    // target is gone — rather than hop to a dead route, the action is
    // dropped until a subject carries enough context to land somewhere real.
    return [
      message,
      mention,
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

  // No "Grants" hop: no deep-link filter exists, and landing on the
  // unfiltered everyone's-rules list is worse than not offering it.
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
  ];
}

/** Shared workbenches are not listed: membership of another principal in
 * a workbench has no stock read, so the card shows none rather than guessing. */
function useSharedWorkbenches(): readonly ProfileCardChannel[] {
  return [];
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
  const { selectedTenantId } = useBench();
  const insertIntoComposer = useInsertIntoComposer();
  const sharedWorkbenches = useSharedWorkbenches();

  return (
    <div className="shell-profile-pane">
      <CanvasPaneHeader focus={focus} onClose={onClose} onToggleFocus={onToggleFocus} />
      <ProfileCard
        name={profile.displayName}
        subtitle={`@${profile.handle}`}
        initials={profile.initials}
        statusLabel={profile.kind === "agent" ? "Agent" : "Member"}
        avatarTone={profile.kind === "agent" ? "agent" : "neutral"}
        actions={profileActions(profile, selectedTenantId, onClose, onNavigate, insertIntoComposer)}
        sharedChannels={sharedWorkbenches}
      />
    </div>
  );
}

/** Whether this render shows `ArtifactTextEditor` instead of the static
 * `ArtifactRenderer`: the artifact has to be a text kind. Whether the
 * resulting pane is interactive is `artifact.canEdit`, checked separately:
 * a viewer without write access still gets `ArtifactTextEditor` in its
 * own `readOnly` mode, just with keystrokes ignored. */
function showsTextEditor(artifact: CanvasArtifactContent): boolean {
  return artifact.rendererKind === "doc";
}

function ArtifactCanvasPane({
  artifact,
  focus,
  onClose,
  onToggleFocus,
  artifactSaveState = { kind: "read-only" },
  onSaveArtifact,
}: {
  readonly artifact: CanvasArtifactContent;
  readonly focus: boolean;
  readonly onClose: () => void;
  readonly onToggleFocus: () => void;
  readonly artifactSaveState?: ArtifactSaveState;
  readonly onSaveArtifact?: (content: string) => void;
}) {
  const showEditor = showsTextEditor(artifact);
  return (
    <div className="shell-artifact-pane">
      <CanvasPaneHeader
        title={artifact.title}
        focus={focus}
        onClose={onClose}
        onToggleFocus={onToggleFocus}
        {...(artifact.previewSrc !== undefined ? { previewSrc: artifact.previewSrc } : {})}
      />
      <div className="shell-artifact-pane-body">
        {showEditor ? (
          <ArtifactTextEditor
            key={artifact.id}
            content={artifact.content}
            title={artifact.title}
            readOnly={!artifact.canEdit}
            saveState={artifactSaveState}
            onSave={onSaveArtifact ?? (() => {})}
          />
        ) : (
          <ArtifactRenderer
            rendererKind={artifact.rendererKind}
            title={artifact.title}
            content={artifact.content}
            {...(artifact.unavailableReason !== undefined
              ? { unavailableReason: artifact.unavailableReason }
              : {})}
            {...(artifact.previewSrc !== undefined ? { previewSrc: artifact.previewSrc } : {})}
          />
        )}
      </div>
    </div>
  );
}
