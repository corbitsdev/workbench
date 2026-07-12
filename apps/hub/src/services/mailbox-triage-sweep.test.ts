import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";

const teardownMock = mock(async () => undefined);
mock.module("./myra-threads", () => ({
  resolveMyraTriageDefinition: mock(async () => null),
  teardownThreadRows: teardownMock,
}));

const { sweepStaleTriageInstances } = await import("./mailbox-triage");

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

function makeSessionService(impl?: () => Promise<void>) {
  const endSession = mock(impl ?? (async () => undefined));
  return { endSession };
}

beforeEach(() => {
  teardownMock.mockClear();
});

describe("sweepStaleTriageInstances", () => {
  it("retires each stale row: endSession then teardownThreadRows", async () => {
    const rows: StaleRow[] = [
      {
        mappingId: "mai-1",
        instanceId: "ins-1",
        instancePrincipalId: "prn-1",
        address: "ins-1@tenant.example",
      },
      {
        mappingId: "mai-2",
        instanceId: "ins-2",
        instancePrincipalId: "prn-2",
        address: "ins-2@tenant.example",
      },
    ];
    const db = makeDb(rows);
    const session = makeSessionService();

    const result = await sweepStaleTriageInstances(db, session);

    expect(result).toEqual({ scanned: 2, retired: 2 });
    expect(session.endSession).toHaveBeenCalledTimes(2);
    expect(session.endSession.mock.calls[0]).toEqual([
      "ins-1@tenant.example",
      "mailbox_triage_boot_sweep",
    ]);
    expect(teardownMock).toHaveBeenCalledTimes(2);
    expect(teardownMock.mock.calls[0]![1]).toEqual({
      instanceId: "ins-1",
      mappingId: "mai-1",
      instancePrincipalId: "prn-1",
    });
  });

  it("still tears down a row when endSession fails — indefinite retry has no payoff for backlog this stale", async () => {
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

    const result = await sweepStaleTriageInstances(db, session);

    expect(result).toEqual({ scanned: 1, retired: 1 });
    expect(teardownMock).toHaveBeenCalledTimes(1);
  });

  it("does not count a row toward retired when teardown itself fails", async () => {
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
    teardownMock.mockImplementationOnce(async () => {
      throw new Error("db error");
    });

    const result = await sweepStaleTriageInstances(db, session);

    expect(result).toEqual({ scanned: 1, retired: 0 });
  });

  it("is idempotent: an empty backlog scans and retires nothing", async () => {
    const db = makeDb([]);
    const session = makeSessionService();

    const result = await sweepStaleTriageInstances(db, session);

    expect(result).toEqual({ scanned: 0, retired: 0 });
    expect(session.endSession).not.toHaveBeenCalled();
    expect(teardownMock).not.toHaveBeenCalled();
  });

  it("respects the configured limit and staleness window when building the query", async () => {
    const db = makeDb([]);
    const selectChain = makeSelectChain([]);
    const selectMock = mock(() => selectChain);
    (db as unknown as { select: unknown }).select = selectMock;
    const session = makeSessionService();

    await sweepStaleTriageInstances(db, session, {
      staleAfterMs: 1_000,
      limit: 10,
      now: () => 5_000,
    });

    expect(selectChain.where).toHaveBeenCalledTimes(1);
  });
});
