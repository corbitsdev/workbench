import { describe, expect, test } from "bun:test";
import { withInboxIntakeTickLock } from "./inbox-intake-cursor";
import type { HubDb } from "../db";

// Fakes a postgres.js reserved-connection tagged-template client, backed by an
// in-memory "session" advisory-lock registry shared across `reserve()` calls
// (mirroring real Postgres: the lock is a server-side resource, not
// per-connection state) so this test can assert the second concurrent tick
// genuinely observes the first tick's lock instead of getting its own.
function fakeReservableDb(locks: Set<number>): HubDb {
  function reservedClient() {
    async function tagged(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<[{ locked: boolean }] | []> {
      const sqlText = strings.join("?");
      const key = values[0] as number;
      if (sqlText.includes("pg_try_advisory_lock")) {
        if (locks.has(key)) return [{ locked: false }];
        locks.add(key);
        return [{ locked: true }];
      }
      if (sqlText.includes("pg_advisory_unlock")) {
        locks.delete(key);
        return [];
      }
      throw new Error(`unexpected query: ${sqlText}`);
    }
    return Object.assign(tagged, { release: () => {} });
  }
  return {
    $client: {
      reserve: async () => reservedClient(),
    },
  } as unknown as HubDb;
}

describe("withInboxIntakeTickLock", () => {
  test("runs fn when the lock is free", async () => {
    const db = fakeReservableDb(new Set());
    let ran = false;
    await withInboxIntakeTickLock(db, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("a second concurrent tick no-ops while the lock is held", async () => {
    const locks = new Set<number>();
    const db = fakeReservableDb(locks);
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withInboxIntakeTickLock(db, async () => {
      order.push("first-start");
      await firstHeld;
      order.push("first-end");
    });

    // Give the first tick's lock-acquire a turn to resolve before starting
    // the second, racing tick.
    await Promise.resolve();
    await Promise.resolve();

    const second = withInboxIntakeTickLock(db, async () => {
      order.push("second-ran");
    });

    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end"]);
  });

  test("releases the lock after fn resolves, so a later tick can acquire it", async () => {
    const locks = new Set<number>();
    const db = fakeReservableDb(locks);
    let count = 0;
    await withInboxIntakeTickLock(db, async () => {
      count += 1;
    });
    await withInboxIntakeTickLock(db, async () => {
      count += 1;
    });
    expect(count).toBe(2);
  });

  test("releases the lock even when fn throws", async () => {
    const locks = new Set<number>();
    const db = fakeReservableDb(locks);
    await expect(
      withInboxIntakeTickLock(db, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    let ran = false;
    await withInboxIntakeTickLock(db, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("skips locking when the client has no reserve() (e.g. the PGlite test driver)", async () => {
    const db = { $client: {} } as unknown as HubDb;
    let ran = false;
    await withInboxIntakeTickLock(db, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
