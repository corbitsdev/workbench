// The current bench's member management: the member list plus the
// invite flow, behind the same loading/empty/error floor every other
// surface follows. Owns the member fetch and the invite mutation
// against `./api`; hosts (the Settings bench section today) only pass
// which bench is current.

import { Button } from "@corbits/react-ui";
import { UserPlus } from "lucide-react";
import { useEffect, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  QueryView,
  UnauthenticatedError,
  describeQueryError,
} from "@corbits/api-query";
import { BenchApiError, inviteMember, listMembers } from "./api";
import type { BenchMember } from "./api";
import { InviteMemberDialog } from "./invite-member-dialog";
import { MemberList } from "./member-list";
import { BENCH_STRINGS } from "./strings";

export function inviteMemberErrorMessage(cause: unknown): string {
  if (cause instanceof BenchApiError) {
    if (cause.status === 404) return BENCH_STRINGS.inviteMemberNotFoundError;
    if (cause.status === 409) return BENCH_STRINGS.inviteMemberConflictError;
  }
  return BENCH_STRINGS.inviteMemberError;
}

function useMembers(tenantId: string): {
  readonly query: APIQuery<readonly BenchMember[]>;
  readonly refresh: () => void;
} {
  const [query, setQuery] = useState<APIQuery<readonly BenchMember[]>>({
    kind: "loading",
  });
  const [generation, setGeneration] = useState(0);
  const refresh = () => setGeneration((value) => value + 1);

  useEffect(() => {
    let cancelled = false;
    setQuery({ kind: "loading" });
    listMembers(tenantId)
      .then((items) => {
        if (!cancelled) setQuery({ kind: "ready", data: items });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof UnauthenticatedError) {
          setQuery({ kind: "unauthenticated" });
          return;
        }
        setQuery({
          kind: "error",
          message: describeQueryError(cause),
          retry: refresh,
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, generation]);

  return { query, refresh };
}

export function MembersPanel({ tenantId }: { readonly tenantId: string }) {
  const { query, refresh } = useMembers(tenantId);

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
      <QueryView query={query} label={BENCH_STRINGS.membersLoadError}>
        {(members) => <MemberList members={members} />}
      </QueryView>
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
