import { CaretDown } from "@/lib/icons";
import { IdentityAvatar } from "@/chat/avatar";
import { Skeleton } from "@corbits/react-ui";
import type { WorkerStatus } from "../worker-status";
import "./bench-pill.css";

/** Frosted pill centered over the thread: the bench's worker and name, plus
 * what the worker is doing while a turn is open. Toggles the bench drawer. */
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
  const working = status.tone === "working";
  const needsYou = status.text === "Needs you";
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
          <Skeleton className="skeleton-avatar" />
        )
      ) : (
        <IdentityAvatar kind="agent" name={worker.name} principalId={worker.id} />
      )}
      <b>{benchName}</b>
      {needsYou && worker !== undefined ? (
        <>
          <span className="pulse" aria-hidden="true" />
          <span className="bench-pill-status">{worker.name} needs you</span>
        </>
      ) : working ? (
        <>
          <span className="pulse" aria-hidden="true" />
          <span className="bench-pill-status">
            {worker === undefined ? "Working …" : `${worker.name} is working …`}
          </span>
        </>
      ) : worker === undefined ? null : (
        <span className="bench-pill-worker">· {worker.name}</span>
      )}
      <CaretDown size={14} aria-hidden="true" />
    </button>
  );
}
