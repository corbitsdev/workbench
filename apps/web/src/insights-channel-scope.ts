// Insights is scoped per channel (CL-5879): `/insights/channel/:channelId`
// resolves to that channel's OWN workbench tenant — every channel minted
// through POST /channels carries a tenancy link (see `ChannelWire.tenancy`
// in @corbits/chat-ui) — never the channel id itself and never the bench's
// root tenant. Both directions of that lookup (a channel id in the URL
// resolving to a tenant id; a tenant id off a usage row resolving back to
// the channel that opens it) go through these two pure functions over the
// SAME cached channel rows the shell's sidebar already fetched, rather
// than a bespoke reverse-lookup endpoint.

import type { Channel } from "@corbits/chat-ui";

export type ChannelInsightsResolution =
  | { readonly kind: "not-found" }
  | { readonly kind: "legacy" }
  | {
      readonly kind: "ready";
      readonly tenantId: string;
      readonly title: string;
    };

/** `channelId` → this channel's own workbench tenant, or an honest reason
 * there isn't one: absent from the bench's channel list at all ("not-found"
 * — the only path a stale `/insights/workbench/:tenantId` link or a
 * mis-typed id can take now that route is retired), or a true legacy
 * channel minted before channel tenancy existed ("legacy", `tenancy` is
 * `null`). */
export function resolveChannelInsightsScope(
  channels: readonly Channel[],
  channelId: string,
): ChannelInsightsResolution {
  const channel = channels.find((c) => c.id === channelId);
  if (channel === undefined) return { kind: "not-found" };
  if (channel.tenancy === undefined || channel.tenancy === null) {
    return { kind: "legacy" };
  }
  return {
    kind: "ready",
    tenantId: channel.tenancy.tenantId,
    title: channel.title,
  };
}

/** The reverse lookup: a workbench usage row only carries the workbench's
 * tenant id (see `WorkbenchUsage` in `./insights-api`) — this finds the
 * channel that opens it, for the "activity by workbench" rows and the
 * scope switcher's sibling pills. Null when no channel in view carries
 * that tenancy (shouldn't happen for a same-bench sibling, but never
 * invents a link). */
export function channelIdForWorkbenchTenant(
  channels: readonly Channel[],
  tenantId: string,
): string | null {
  return (
    channels.find(
      (c) =>
        c.tenancy !== undefined &&
        c.tenancy !== null &&
        c.tenancy.tenantId === tenantId,
    )?.id ?? null
  );
}
