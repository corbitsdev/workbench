import { SessionLaunchError } from "@intx/hub-sessions";

/**
 * Mirrors `@workbench/hub-client`'s `SidecarUnavailableError` discrimination
 * (`packages/hub-client/src/errors.ts`), but for the in-process launch path:
 * a mint's host or agent launch calls `@intx/hub-sessions` directly rather
 * than over HTTP, so there is no 502 to parse. Instead this matches the
 * exact `SessionLaunchError` shape `sidecarRouter.sendAgentDeploy` raises
 * when no sidecar is connected to run the deploy at all — phase
 * `"provision"`, message exactly `No sidecar available for agent "<addr>"`
 * or `No sidecar connected for agent "<addr>"` (see
 * `vendor/intx/hub-sessions/src/ws/sidecar-handler.ts`). Every other
 * `SessionLaunchError` (a bad definition, an inference failure, a crash
 * mid-provision) is a genuine rejection and still compensates.
 */
export function isSidecarUnavailableLaunchError(err: unknown): boolean {
  if (!(err instanceof SessionLaunchError)) return false;
  if (err.phase !== "provision") return false;
  return /^No sidecar (available|connected) for agent "/.test(err.message);
}
