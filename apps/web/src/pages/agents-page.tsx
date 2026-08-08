import {
  Button,
  EmptyState,
  PageShell,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TopBar,
  TopBarTitle,
} from "@corbits/react-ui";
import { InviteAgentDialog, inviteAgent, listChannels } from "@corbits/chat-ui";
import type { Channel, ParticipantRecord } from "@corbits/chat-ui";
import { Bot } from "lucide-react";
import { useEffect, useState } from "react";

import { PrincipalsSchema, useAPIQuery } from "../api";
import { countProp } from "../optional-props";
import type { APIQuery } from "../api";
import { QueryView } from "../query-view";

type TenantChannels = {
  readonly tenantId: string;
  readonly channels: readonly Channel[];
};

/**
 * A participant's mention handle, never its raw address on screen — the UI
 * floor covers every surface, so the address does not appear here at all,
 * not even as a tooltip.
 */
function ParticipantHandles({
  participants,
}: {
  readonly participants: readonly ParticipantRecord[];
}) {
  if (participants.length === 0) {
    return <span className="text-muted-foreground">No participants</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {participants.map((participant) => (
        <span
          key={participant.address}
          className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs"
        >
          @{participant.handle}
        </span>
      ))}
    </span>
  );
}

/**
 * Agent definitions you can invite, one channel at a time: the channel
 * table doubles as "who's active where" (its participants), and each row's
 * "Invite agent" action opens `@corbits/chat-ui`'s existing
 * `InviteAgentDialog` — the same list the chat surface's own invite flow
 * uses, so this page never re-derives what counts as invitable.
 */
export function AgentsPage({
  tenant,
}: {
  readonly tenant: APIQuery<TenantChannels>;
}) {
  const [inviteChannel, setInviteChannel] = useState<Channel | null>(null);

  return (
    <>
      <TopBar>
        <TopBarTitle
          {...countProp(
            tenant.kind === "ready" ? tenant.data.channels.length : undefined,
          )}
          subtitle="Agent definitions you can invite, and the channels they join"
        >
          Agents
        </TopBarTitle>
      </TopBar>
      <PageShell width="full" className="page-fill">
        <QueryView query={tenant} label="your channels">
          {({ tenantId, channels }) =>
            channels.length === 0 ? (
              <EmptyState
                icon={<Bot />}
                title="No channel to invite an agent into"
                description="Create a channel in Chat first — agents join channels, not the workspace at large."
              />
            ) : (
              <>
                <Table aria-label="Channels">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Channel</TableHead>
                      <TableHead>Participants</TableHead>
                      <TableHead>
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {channels.map((channel) => (
                      <TableRow key={channel.id}>
                        <TableCell className="font-medium">
                          {channel.title}
                        </TableCell>
                        <TableCell>
                          <ParticipantHandles
                            participants={channel.participants}
                          />
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setInviteChannel(channel)}
                          >
                            Invite agent
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {inviteChannel === null ? null : (
                  <InviteAgentDialog
                    open
                    onOpenChange={(open) => {
                      if (!open) setInviteChannel(null);
                    }}
                    tenantId={tenantId}
                    channelId={inviteChannel.id}
                    onInvite={(definitionId) =>
                      inviteAgent(
                        tenantId,
                        inviteChannel.id,
                        definitionId,
                      ).then(() => undefined)
                    }
                  />
                )}
              </>
            )
          }
        </QueryView>
      </PageShell>
    </>
  );
}

export function AgentsRoute() {
  const principals = useAPIQuery("/api/me/principals", PrincipalsSchema);
  const [channels, setChannels] = useState<APIQuery<TenantChannels>>({
    kind: "loading",
  });

  useEffect(() => {
    if (principals.kind !== "ready") {
      setChannels(principals);
      return;
    }
    const membership = principals.data.data[0];
    if (membership === undefined) {
      setChannels({ kind: "ready", data: { tenantId: "", channels: [] } });
      return;
    }
    let cancelled = false;
    setChannels({ kind: "loading" });
    listChannels(membership.tenantId, "channel")
      .then((items) => {
        if (!cancelled) {
          setChannels({
            kind: "ready",
            data: { tenantId: membership.tenantId, channels: items },
          });
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setChannels({
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [principals]);

  return <AgentsPage tenant={channels} />;
}
