import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";

const teardownMock = mock(
  async (_db: unknown, _opts: Record<string, unknown>) => undefined,
);
mock.module("./myra-threads", () => ({
  resolveMyraDefinition: mock(async () => null),
  teardownThreadRows: teardownMock,
}));

const { sweepStaleScheduledGateInstances } = await import(
  "./scheduled-workflow-gate-agent"
);

type StaleRow = {
  mappingId: string;
  instanceId: string;
  instancePrincipalId: string;
  address: string;
};

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeSelectChain(rows: StaleRow[]): any {
  const limited = mock(() => Promise.resolve(rows));
  const wherePromise = Promise.resolve(rows) as Promise<StaleRow[]> & {
    limit: unknown;
  };
  wherePromise.limit = limited;
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const chain: any = {
    from: mock(() => chain),
    innerJoin: mock(() => chain),
    where: mock(() => wherePromise),
  };
  return chain;
}

function makeDb(rows: StaleRow[]): HubDb {
  return {
    select: mock(() => makeSelectChain(rows)),
  } as unknown as HubDb;
}

function makeSessionService(
  impl?: (address: string, reason: string) => Promise<void>,
) {
  const endSession = mock(
    impl ?? (async (_address: string, _reason: string) => undefined),
  );
  return { endSession };
}

beforeEach(() => {
  teardownMock.mockClear();
});

describe("sweepStaleScheduledGateInstances", () => {
  it("retires each stale row: endSession then teardownThreadRows", async () => {
    const rows: StaleRow[] = [
      {
        mappingId: "mai-1",
        instanceId: "ins-1",
        instancePrincipalId: "prn-1",
        address: "ins-1@tenant.example",
      },
    ];
    const db = makeDb(rows);
    const session = makeSessionService();

    const result = await sweepStaleScheduledGateInstances(db, session);

    expect(result).toEqual({ scanned: 1, retired: 1 });
    expect(session.endSession).toHaveBeenCalledWith(
      "ins-1@tenant.example",
      "scheduled_gate_boot_sweep",
    );
    expect(teardownMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a row when endSession fails", async () => {
    const rows: StaleRow[] = [
      {
        mappingId: "mai-1",
        instanceId: "ins-1",
        instancePrincipalId: "prn-1",
        address: "ins-1@tenant.example",
      },
    ];
    const db = makeDb(rows);
    const session = makeSessionService(async () => {
      throw new Error("sidecar unreachable");
    });

    const result = await sweepStaleScheduledGateInstances(db, session);

    expect(result).toEqual({ scanned: 1, retired: 0 });
    expect(teardownMock).not.toHaveBeenCalled();
  });
});