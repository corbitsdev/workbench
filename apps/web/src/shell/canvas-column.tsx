// Column 4: the optional canvas. Collapsed, it takes no space at all — the
// main pane gets the width back — and open, it hosts the channel chat
// surface (the retired `/chat` page's `ChatWorkspace`). Agent runs and
// live workflow walkthroughs will share this column later; today a channel
// is the only content it can load.
//
// The collapse/expand motion lives entirely in `shell.css` as a CSS
// transition on `transform`/`opacity` (plus width, so the main pane
// actually reflows) triggered by the `data-open` attribute — never a JS
// animation — so rapid toggling is inherently interruptible: the browser
// just reverses whichever transition is already in flight, there is no
// queue to get stuck. `prefers-reduced-motion` is handled the same way, in
// CSS, by shortening the transition to near-zero.

import { Button, EmptyState } from "@corbits/react-ui";
import { ChatWorkspace } from "@corbits/chat-ui";
import type { TenantResolution } from "@corbits/chat-ui";
import { LayoutPanelLeft, MessageSquare, PanelRightClose } from "lucide-react";

import { useBench } from "../bench-context";

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
  onChannelChange,
}: {
  readonly open: boolean;
  readonly channelId: string | null;
  readonly onChannelChange: (channelId: string) => void;
}) {
  const { memberships, selectedTenantId, selectedPrincipalId } = useBench();

  let tenant: TenantResolution;
  if (memberships.kind !== "ready") {
    tenant = memberships;
  } else {
    tenant =
      selectedTenantId === null
        ? { kind: "empty" }
        : { kind: "ready", tenantId: selectedTenantId };
  }
  const principalId = selectedPrincipalId ?? undefined;

  // `inert` rather than `aria-hidden`: a collapsed column has to be out of
  // both the accessibility tree and the tab order, and `aria-hidden` alone
  // only does the first — a focusable descendant inside an `aria-hidden`
  // subtree is an ARIA violation, and the browser moves focus out of an
  // `inert` subtree for us when it closes.
  return (
    <div className="shell-canvas-column" data-open={open} inert={!open}>
      <div className="shell-canvas-inner">
        {channelId === null ? (
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
            {...(principalId !== undefined
              ? { currentUser: { principalId } }
              : {})}
          />
        )}
      </div>
    </div>
  );
}
