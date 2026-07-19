import { readFileSync } from "node:fs";

/**
 * Linux page size in bytes for the resident-set-size calculation
 * below. `/proc/<pid>/statm`'s second field is resident pages, not
 * bytes; 4 KiB is the page size on every Linux target this sidecar
 * ships to (x86_64 containers). There is no portable way to read the
 * live page size from within the process, so this is a fixed
 * assumption rather than a query.
 */
const LINUX_PAGE_SIZE_BYTES = 4096;

/**
 * Host-side RSS reader for a workflow-process child, wired into the
 * supervisor's recycle policy through `WorkflowSupervisorBindings.
 * readRssBytes` (see `createSidecarWorkflowSupervisor` in
 * `workflow-host-wiring.ts`). Reads `/proc/<pid>/statm` directly:
 * resident pages (field 2) times the page size.
 *
 * Linux only. Any failure -- non-Linux platform, the pid has already
 * exited, malformed `statm` content -- returns `undefined` so the
 * supervisor's max-rss bound is simply skipped for that tick rather
 * than tripped on bad data. There is intentionally no non-Linux
 * fallback (e.g. spawning `ps`): a synchronous subprocess per policy
 * tick per supervisor can stall the shared sidecar host, and every
 * deployed sidecar target is Linux.
 */
export function readChildRssBytes(pid: number): number | undefined {
  if (process.platform !== "linux") return undefined;
  if (!Number.isFinite(pid) || pid <= 0) return undefined;
  try {
    const statm = readFileSync(`/proc/${String(pid)}/statm`, "utf8");
    const residentPages = Number(statm.trim().split(/\s+/)[1]);
    if (!Number.isFinite(residentPages) || residentPages <= 0) {
      return undefined;
    }
    return residentPages * LINUX_PAGE_SIZE_BYTES;
  } catch {
    return undefined;
  }
}
