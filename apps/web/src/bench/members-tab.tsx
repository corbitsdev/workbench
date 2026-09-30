import { RichEmptyState, Skeleton } from "@corbits/react-ui";
import { useQuery } from "@tanstack/react-query";

import { IdentityAvatar, WorkbenchAvatar } from "@/chat/avatar";
import type { WorkbenchParticipant } from "@/chat/threads-api";
import { Link } from "../navigation";
import { tenantKeys } from "../query-client";
import { principalLabel } from "../settings/identity";
import { listPrincipals } from "../settings/tenancy-api";

/** Humans are the bench tenant's user principals; agents are the bench's
 * workers, already listed as participants. */
export function MembersTab({
  workbenchTenantId,
  participants,
  loading,
}: {
  readonly workbenchTenantId: string;
  /** True until the roster resolves; an empty list then isn't "no agents". */
  readonly loading: boolean;
  readonly participants: readonly WorkbenchParticipant[];
}) {
  // A distinct key from Settings -> People, which caches a different shape
  // under the bare principals key; prefix invalidation still reaches both.
  const people = useQuery({
    queryKey: [...tenantKeys.principals(workbenchTenantId), "members"],
    queryFn: async () => (await listPrincipals(workbenchTenantId)).filter((p) => p.kind === "user"),
  });
  const agents = participants.filter((p) => p.kind === "agent");

  return (
    <div>
      <section className="drawer-sec">
        <div className="drawer-sec-head">
          <h3>People</h3>
        </div>
        {people.isPending ? <Skeleton className="h-12 w-full" /> : null}
        {people.isError ? (
          <RichEmptyState
            title="Couldn't load people"
            description="Something went wrong on our side. Try again in a moment."
            actions={[{ label: "Retry", onClick: () => void people.refetch() }]}
          />
        ) : null}
        {people.data?.length === 0 ? (
          <p className="workbench-info-empty-note">No people yet.</p>
        ) : null}
        <ul className="drawer-list">
          {(people.data ?? []).map((person) => {
            const { label } = principalLabel(person.displayName);
            const detail = [person.email, person.roles.map((r) => r.name).join(", ")]
              .filter((s): s is string => s !== undefined && s !== "")
              .join(" · ");
            return (
              <li key={person.id}>
                <IdentityAvatar kind="person" name={label} principalId={person.id} />
                <span className="drawer-list-text">
                  <b>{label}</b>
                  <span>{detail}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="drawer-sec">
        <div className="drawer-sec-head">
          <h3>Agents</h3>
        </div>
        {loading ? <Skeleton className="h-12 w-full" /> : null}
        {!loading && agents.length === 0 ? (
          <p className="workbench-info-empty-note">No agents yet.</p>
        ) : null}
        <ul className="drawer-list">
          {agents.map((agent) => (
            <li key={agent.id}>
              <Link className="drawer-list-link" to={`/workers/${encodeURIComponent(agent.id)}`}>
                <WorkbenchAvatar kind="worker" name={agent.name} size="md" />
                <span className="drawer-list-text">
                  <b>{agent.name}</b>
                  <span>{agent.address === "" ? "Starting" : "Running"}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
