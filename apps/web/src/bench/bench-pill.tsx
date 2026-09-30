import { CaretDown } from "@/lib/icons";
import { IdentityAvatar } from "@/chat/avatar";
import { Skeleton } from "@corbits/react-ui";
import type { WorkerStatus } from "../worker-status";

function statusLine(status: WorkerStatus, workerName: string | undefined): string {
  if (status.text === "Working…") {
    return workerName === undefined ? "Working…" : `${workerName} is working…`;
  }
  const text = status.text === "Live" ? "Idle" : status.text;
  return workerName === undefined ? text : `${workerName} · ${text}`;
}

/** Frosted pill centered over the thread: the bench's worker, its name and
 * live status. Toggles the bench drawer. */
export function BenchPill({
  benchName,
  worker,
  status,
  rosterReady,
  open,
  onToggle,
}: {
  readonly benchName: string;
  readonly worker: { readonly id: string; readonly name: string } | undefined;
  readonly status: WorkerStatus;
  /** False until the roster resolves; the avatar holds a skeleton. */
  readonly rosterReady: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="bench-pill"
      aria-expanded={open}
      aria-controls="bench-drawer"
      onClick={onToggle}
    >
      {worker === undefined ? (
        rosterReady ? null : (
          <Skeleton className="size-6 rounded-full" />
        )
      ) : (
        <IdentityAvatar kind="agent" name={worker.name} principalId={worker.id} />
      )}
      <b>{benchName}</b>
      <span className="bench-pill-status">{statusLine(status, worker?.name)}</span>
      <CaretDown size={14} aria-hidden="true" />
    </button>
  );
}
