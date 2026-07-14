import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, ConfirmButton } from "@workbench/ui";
import {
  demoteOwnerMember,
  getOwnerMembers,
  promoteOwnerMember,
} from "../../lib/hub-api";
import { adminTableCard } from "./admin-ui";

function apiMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * Owner → Members. Grant/revoke the `owner` system role for other tenant
 * members. Every mutation is enforced by the owner grant guard server-side
 * (`/owner/members/:id/promote|demote`) — this page is a thin UI over that
 * surface, not an independent permission model. Promotion/demotion take
 * effect immediately: the owner gate re-resolves grants on every request, no
 * cache to invalidate.
 */
export function OwnerMembers() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const members = useQuery({
    queryKey: ["owner", "members"],
    queryFn: getOwnerMembers,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["owner", "members"] });

  const promote = useMutation({
    mutationFn: (principalId: string) => promoteOwnerMember(principalId),
    onSuccess: invalidate,
  });
  const demote = useMutation({
    mutationFn: (principalId: string) => demoteOwnerMember(principalId),
    onSuccess: invalidate,
  });

  const pending = promote.isPending || demote.isPending;

  if (members.isLoading) {
    return <p className="p-3 text-sm text-text-2">Loading…</p>;
  }
  if (members.isError || !members.data) {
    return (
      <p className="p-3 text-sm text-text-2">
        Could not load members. Try again in a moment.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-2">
        Grant or revoke owner access for other workbench members. Owners can
        manage everything in this Owner area, including granting owner access to
        others.
      </p>
      {error && (
        <p className="text-sm text-red-500" role="status">
          {error}
        </p>
      )}
      <div className={adminTableCard}>
        <ul className="divide-y divide-border">
          {members.data.members.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between gap-4 p-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm text-text">
                  {m.displayName}
                </span>
                {m.isOwner && <Badge tone="accent">owner</Badge>}
              </div>
              {m.isOwner ? (
                <ConfirmButton
                  size="sm"
                  variant="secondary"
                  confirmLabel="Confirm remove owner"
                  disabled={pending}
                  onConfirm={() => {
                    setError(null);
                    demote.mutate(m.id, {
                      onError: (e) => setError(apiMessage(e)),
                    });
                  }}
                >
                  Remove owner
                </ConfirmButton>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    setError(null);
                    promote.mutate(m.id, {
                      onError: (e) => setError(apiMessage(e)),
                    });
                  }}
                >
                  Make owner
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
