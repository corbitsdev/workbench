import { getLogger } from "@intx/log";

const log = getLogger(["services", "scheduled-trigger-seeder"]);

export interface HeartbeatSeederDeps {
  enabled: boolean;
  kind: string;
  hourUtc: number;
  // Members with a Myra instance — the users a morning heartbeat targets.
  listMyraTargets: () => Promise<{ memberPrincipalId: string }[]>;
  // EPIC-INTEGRATION: swap to deriveUserMailAddress from @workbench/hub-agent.
  // Resolves the member principal's user mail address (`${refId}@${domain}`).
  resolveUserAddress: (memberPrincipalId: string) => Promise<string>;
  // Idempotent upsert (does not overwrite an existing schedule).
  ensureSchedule: (args: {
    ownerPrincipalId: string;
    kind: string;
    hourUtc: number;
    payload: Record<string, unknown>;
  }) => Promise<void>;
}

// Boot-time idempotent seed so the morning brief works out of the box: ensure
// one heartbeat schedule per member with a Myra instance. Members can later
// customize hour/enablement via /me/schedules (CL-2297); the underlying upsert
// never overwrites an existing row, so customization survives reboots. Gated by
// the scheduler enable flag. Best-effort per target: one member's failure is
// logged and never aborts the sweep.
export async function seedHeartbeatSchedules(
  deps: HeartbeatSeederDeps,
): Promise<{ seeded: number }> {
  if (!deps.enabled) {
    log.info("heartbeat seed: disabled");
    return { seeded: 0 };
  }

  let targets: { memberPrincipalId: string }[];
  try {
    targets = await deps.listMyraTargets();
  } catch (err) {
    log.error("heartbeat seed: enumerate failed", {
      error: err instanceof Error ? err : new Error(String(err)),
    });
    return { seeded: 0 };
  }

  let seeded = 0;
  for (const target of targets) {
    try {
      const userAddress = await deps.resolveUserAddress(
        target.memberPrincipalId,
      );
      // The address is `${refId}@${domain}` by construction, so the refId is
      // the segment before the final `@` (lastIndexOf tolerates an email refId).
      const at = userAddress.lastIndexOf("@");
      const userRefId = at > 0 ? userAddress.slice(0, at) : userAddress;
      await deps.ensureSchedule({
        ownerPrincipalId: target.memberPrincipalId,
        kind: deps.kind,
        hourUtc: deps.hourUtc,
        payload: { reason: "scheduled-heartbeat", userAddress, userRefId },
      });
      seeded += 1;
    } catch (err) {
      log.error("heartbeat seed: ensure failed", {
        memberPrincipalId: target.memberPrincipalId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  log.info("heartbeat seed complete", { seeded, targets: targets.length });
  return { seeded };
}
