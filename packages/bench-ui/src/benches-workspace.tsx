// The bench management page: memberships in one panel, the current bench's
// member list in another, both behind the same loading/empty/error floor
// every other surface in this app follows. The caller supplies the
// memberships listing (it's already fetched at the app level for the
// switcher and for chat) and which bench is selected; this component owns
// everything downstream of that — the member fetch, and the create/invite
// flows — against `./api`.

import {
  Badge,
  Button,
  EmptyState,
  PageShell,
  Skeleton,
  TopBar,
  TopBarTitle,
} from "@corbits/react-ui";
import { CircleAlert, Plus, UserPlus, Users } from "lucide-react";
import { useEffect, useState } from "react";

import { BenchApiError, createBench, inviteMember, listMembers } from "./api";
import type { Bench, BenchMember, BenchMembership } from "./api";
import { CreateBenchDialog } from "./create-bench-dialog";
import { InviteMemberDialog } from "./invite-member-dialog";
import { deriveBenchSlug, membershipDisplay } from "./membership";
import { MemberList } from "./member-list";
import { MembershipsTable } from "./memberships-table";
import { BENCH_STRINGS } from "./strings";

export type MembershipsResolution =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly BenchMembership[] };

type MembersState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly BenchMember[] };

function createBenchErrorMessage(cause: unknown): string {
  if (cause instanceof BenchApiError && cause.status === 409) {
    return BENCH_STRINGS.createBenchConflictError;
  }
  return BENCH_STRINGS.createBenchError;
}

function inviteMemberErrorMessage(cause: unknown): string {
  if (cause instanceof BenchApiError) {
    if (cause.status === 404) return BENCH_STRINGS.inviteMemberNotFoundError;
    if (cause.status === 409) return BENCH_STRINGS.inviteMemberConflictError;
  }
  return BENCH_STRINGS.inviteMemberError;
}

function useMembers(tenantId: string | null): {
  readonly state: MembersState;
  readonly refresh: () => void;
} {
  const [state, setState] = useState<MembersState>({ kind: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (tenantId === null) return;
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

export function BenchesWorkspace({
  memberships,
  selectedTenantId,
  onSelectTenant,
  onBenchCreated,
}: {
  readonly memberships: MembershipsResolution;
  readonly selectedTenantId: string | null;
  readonly onSelectTenant: (tenantId: string) => void;
  readonly onBenchCreated: (bench: Bench) => void;
}) {
  const { state: membersState, refresh: refreshMembers } =
    useMembers(selectedTenantId);

  const [createOpen, setCreateOpen] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  function handleCreate(name: string) {
    setCreateSubmitting(true);
    setCreateError(null);
    createBench({ name, slug: deriveBenchSlug(name) })
      .then((bench) => {
        setCreateSubmitting(false);
        setCreateOpen(false);
        onBenchCreated(bench);
      })
      .catch((cause: unknown) => {
        setCreateSubmitting(false);
        setCreateError(createBenchErrorMessage(cause));
      });
  }

  function handleInvite(email: string) {
    if (selectedTenantId === null) return;
    setInviteSubmitting(true);
    setInviteError(null);
    inviteMember(selectedTenantId, email)
      .then(() => {
        setInviteSubmitting(false);
        setInviteOpen(false);
        refreshMembers();
      })
      .catch((cause: unknown) => {
        setInviteSubmitting(false);
        setInviteError(inviteMemberErrorMessage(cause));
      });
  }

  const selectedMembership =
    memberships.kind === "ready"
      ? memberships.items.find((item) => item.tenantId === selectedTenantId)
      : undefined;

  return (
    <>
      <TopBar>
        <TopBarTitle subtitle={BENCH_STRINGS.pageSubtitle}>
          {BENCH_STRINGS.pageTitle}
        </TopBarTitle>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          <Plus />
          {BENCH_STRINGS.createBenchAction}
        </Button>
      </TopBar>
      <PageShell width="wide" className="page-fill">
        <section className="bench-panel">
          <header className="bench-panel-header">
            <h2>{BENCH_STRINGS.membershipsSectionTitle}</h2>
            <p>{BENCH_STRINGS.membershipsSectionDescription}</p>
          </header>
          {memberships.kind === "loading" ? (
            <Skeleton className="query-skeleton" />
          ) : memberships.kind === "error" ? (
            <EmptyState
              icon={<CircleAlert />}
              title={`Couldn't load ${BENCH_STRINGS.membershipsLoadError}`}
              description={memberships.message}
            />
          ) : (
            <MembershipsTable
              memberships={memberships.items}
              activeTenantId={selectedTenantId}
              onSelect={onSelectTenant}
            />
          )}
        </section>

        <section className="bench-panel">
          <header className="bench-panel-header">
            <h2>
              {BENCH_STRINGS.membersSectionTitle}
              {selectedMembership !== undefined && (
                <Badge tone="neutral" className="bench-panel-badge">
                  {membershipDisplay(selectedMembership).name}
                </Badge>
              )}
            </h2>
            <p>{BENCH_STRINGS.membersSectionDescription}</p>
            {selectedTenantId !== null && (
              <Button variant="outline" onClick={() => setInviteOpen(true)}>
                <UserPlus />
                {BENCH_STRINGS.inviteMemberAction}
              </Button>
            )}
          </header>
          {selectedTenantId === null ? (
            <EmptyState
              icon={<Users />}
              title={BENCH_STRINGS.noBenchSelectedTitle}
              description={BENCH_STRINGS.noBenchSelectedDescription}
            />
          ) : membersState.kind === "loading" ? (
            <Skeleton className="query-skeleton" />
          ) : membersState.kind === "error" ? (
            <EmptyState
              icon={<CircleAlert />}
              title={`Couldn't load ${BENCH_STRINGS.membersLoadError}`}
              description={membersState.message}
            />
          ) : (
            <MemberList members={membersState.items} />
          )}
        </section>
      </PageShell>

      <CreateBenchDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={handleCreate}
        submitting={createSubmitting}
        error={createError}
      />
      {selectedTenantId !== null && (
        <InviteMemberDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          onInvite={handleInvite}
          submitting={inviteSubmitting}
          error={inviteError}
        />
      )}
    </>
  );
}
