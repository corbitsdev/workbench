import { RichEmptyState, Skeleton } from "@corbits/react-ui";
import { useQuery } from "@tanstack/react-query";

import { WorkbenchAvatar } from "@/chat/avatar";
import { listChatAgents, type WorkbenchParticipant } from "@/chat/threads-api";
import { CaretRight } from "@/lib/icons";
import { Link } from "../navigation";
import { tenantKeys } from "../query-client";
import { principalLabel } from "../settings/identity";
import { listPrincipals } from "../settings/tenancy-api";
import { useWorkerRole } from "../worker-role-query";
import { useWorkerStatus } from "../worker-status";
import "./drawer.css";

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function WorkerRow({
  workbenchTenantId,
  participant,
}: {
  readonly workbenchTenantId: string;
  readonly participant: WorkbenchParticipant;
}) {
  const agents = useQuery({
    queryKey: tenantKeys.agents(workbenchTenantId),
    queryFn: () => listChatAgents(workbenchTenantId),
  });
  const agent = agents.data?.find((a) => a.id === participant.id);
  const status = useWorkerStatus(workbenchTenantId, participant.id);
  const body = (
    <>
      <WorkbenchAvatar kind="worker" name={participant.name} size="md" status={status.tone} />
      <span className="drawer-list-text">
        <b>{participant.name}</b>
        {agent === undefined ? null : (
          <WorkerRoleLine workbenchTenantId={workbenchTenantId} agent={agent} />
        )}
      </span>
      <CaretRight size={14} aria-hidden="true" />
    </>
  );
  return (
    <li>
      <Link className="drawer-list-link" to={`/workers/${encodeURIComponent(participant.id)}`}>
        {body}
      </Link>
    </li>
  );
}

function WorkerRoleLine({
  workbenchTenantId,
  agent,
}: {
  readonly workbenchTenantId: string;
  readonly agent: Parameters<typeof useWorkerRole>[1];
}) {
  return <span>{useWorkerRole(workbenchTenantId, agent)}</span>;
}

/** Humans are the bench tenant's user principals; workers are the bench's
 * agents, already listed as participants. */
export function MembersTab({
  workbenchTenantId,
  participants,
  loading,
}: {
  readonly workbenchTenantId: string;
  /** True until the roster resolves; an empty list then isn't "no workers". */
  readonly loading: boolean;
  readonly participants: readonly WorkbenchParticipant[];
}) {
  // A distinct key from Settings -> People, which caches a different shape
  // under the bare principals key; prefix invalidation still reaches both.
  const people = useQuery({
    queryKey: [...tenantKeys.principals(workbenchTenantId), "members"],
    queryFn: async () => (await listPrincipals(workbenchTenantId)).filter((p) => p.kind === "user"),
  });
  const workers = participants.filter((p) => p.kind === "agent");

  return (
    <div>
      <section className="drawer-sec">
        <div className="drawer-sec-head">
          <h3>People</h3>
          <Link to="/settings/people">Invite</Link>
        </div>
        {people.isPending ? <Skeleton className="skeleton-row-lg" /> : null}
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
            const name = capitalize(principalLabel(person.displayName).label);
            const role = person.roles.map((r) => capitalize(r.name)).join(", ");
            return (
              <li key={person.id}>
                <WorkbenchAvatar kind="person" name={name} size="md" />
                <span className="drawer-list-text">
                  <b>{name}</b>
                  {role === "" ? null : <span>{role}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="drawer-sec">
        <div className="drawer-sec-head">
          <h3>Workers</h3>
          <Link to="/workers">Add</Link>
        </div>
        {loading ? <Skeleton className="skeleton-row-lg" /> : null}
        {!loading && workers.length === 0 ? (
          <p className="workbench-info-empty-note">No workers yet.</p>
        ) : null}
        <ul className="drawer-list">
          {workers.map((worker) => (
            <WorkerRow key={worker.id} workbenchTenantId={workbenchTenantId} participant={worker} />
          ))}
        </ul>
      </section>
    </div>
  );
}
