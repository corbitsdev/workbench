import { CaretDown } from "@/lib/icons";
import { IdentityAvatar } from "@/chat/avatar";
import type { WorkerStatus } from "../worker-status";

/** Frosted pill centered over the thread: the bench's worker, its name and
 * live status. Toggles the bench drawer. */
export function BenchPill({
  benchName,
  worker,
  status,
  open,
  onToggle,
}: {
  readonly benchName: string;
  readonly worker: { readonly id: string; readonly name: string } | undefined;
  readonly status: WorkerStatus;
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
      {worker === undefined ? null : (
        <IdentityAvatar
          kind="agent"
          name={worker.name}
          principalId={worker.id}
          status={status.tone}
        />
      )}
      <b>{benchName}</b>
      <span className="bench-pill-status">{status.text}</span>
      <CaretDown size={14} aria-hidden="true" />
    </button>
  );
}
