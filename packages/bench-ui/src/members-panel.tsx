// The current bench's member management: the member list plus the
// invite flow, behind the same loading/empty/error floor every other
// surface follows. Owns the member fetch and the invite mutation
// against `./api`; hosts (the Settings bench section today) only pass
// which bench is current.

import { Button, EmptyState, Skeleton } from "@corbits/react-ui";
import { CircleAlert, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";

import { BenchApiError, inviteMember, listMembers } from "./api";
import type { BenchMember } from "./api";
import { InviteMemberDialog } from "./invite-member-dialog";
import { MemberList } from "./member-list";
import { BENCH_STRINGS } from "./strings";

type MembersState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly BenchMember[] };

export function inviteMemberErrorMessage(cause: unknown): string {
  if (cause instanceof BenchApiError) {
    if (cause.status === 404) return BENCH_STRINGS.inviteMemberNotFoundError;
    if (cause.status === 409) return BENCH_STRINGS.inviteMemberConflictError;
  }
  return BENCH_STRINGS.inviteMemberError;
}

function useMembers(tenantId: string): {
  readonly state: MembersState;
  readonly refresh: () => void;
} {
  const [state, setState] = useState<MembersState>({ kind: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    listMembers(tenantId)
      .then((items) => {
        if (!cancelled) setState({ kind: "ready", items });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, generation]);

  return { state, refresh: () => setGeneration((value) => value + 1) };
}

export function MembersPanel({ tenantId }: { readonly tenantId: string }) {
  const { state, refresh } = useMembers(tenantId);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  function handleInvite(email: string) {
    setInviteSubmitting(true);
    setInviteError(null);
    inviteMember(tenantId, email)
      .then(() => {
        setInviteSubmitting(false);
        setInviteOpen(false);
        refresh();
      })
      .catch((cause: unknown) => {
        setInviteSubmitting(false);
        setInviteError(inviteMemberErrorMessage(cause));
      });
  }

  return (
    <section className="bench-panel">
      <header className="bench-panel-header">
        <h2>{BENCH_STRINGS.membersSectionTitle}</h2>
        <p>{BENCH_STRINGS.membersSectionDescription}</p>
        <Button variant="outline" onClick={() => setInviteOpen(true)}>
          <UserPlus />
          {BENCH_STRINGS.inviteMemberAction}
        </Button>
      </header>
      {state.kind === "loading" ? (
        <Skeleton className="query-skeleton" />
      ) : state.kind === "error" ? (
        <EmptyState
          icon={<CircleAlert />}
          title={`Couldn't load ${BENCH_STRINGS.membersLoadError}`}
          description={state.message}
        />
      ) : (
        <MemberList members={state.items} />
      )}
      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvite={handleInvite}
        submitting={inviteSubmitting}
        error={inviteError}
      />
    </section>
  );
}
