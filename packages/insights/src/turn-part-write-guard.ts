// Guards `turn_part` inserts against a race in the vendored event
// collector (`@intx/hub-sessions`, see VENDORED.md): `createEventCollector`
// dispatches InferenceEvents without serializing per-agent processing, so a
// turn_part insert referencing a just-created `inference_turn`/`agent_session`
// row can reach Postgres on a different pooled connection before that
// parent row's own INSERT commits — a transient 23503
// foreign_key_violation, not a real data-shape problem.
//
// Drizzle's own `DrizzleQueryError.message` is just the query text and
// param list ("Failed query: ...\nparams: ..."); the real Postgres error
// sits on `.cause`. The registry's `dispatch()` catch logs only
// `err.message` and drops `.cause`, so today every one of these races is an
// invisible WRN with no diagnosable detail and a permanently lost part —
// see the "hub·event-collector-registry: Failed to persist event" reports.
//
// This wraps the `db` handle passed to `createEventCollectorRegistry` so a
// `turn_part` insert retries once on that specific race (the parent row
// commits within milliseconds), and — win or lose — a genuine loss is never
// just a swallowed WRN again: the real cause is logged at error level and
// counted. Only `turn_part` inserts are touched; every other table's insert
// passes through untouched.
import { turnPart } from "@intx/db/schema";
import { pgErrorCode, PG_FOREIGN_KEY_VIOLATION } from "@intx/db";
import type { DB } from "@intx/db";
import { getLogger } from "@intx/log";

const log = getLogger(["insights", "turn-part-write-guard"]);

const RETRY_DELAY_MS = 25;

/** Process-lifetime count of turn_part inserts lost for good, after any
 * retry — the audit-visible counterpart to the error log below. */
export const turnPartPersistFailures = {
  count: 0,
  reset(): void {
    this.count = 0;
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function causeMessage(err: unknown): string {
  const cause = err instanceof Error ? err.cause : undefined;
  return cause instanceof Error ? cause.message : "no cause captured";
}

type InsertBuilder = { values: (...args: unknown[]) => Promise<unknown> };

export function withTurnPartPersistGuard(db: DB["db"]): DB["db"] {
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop !== "insert") {
        return Reflect.get(target, prop, receiver);
      }
      const insert = Reflect.get(target, prop, target) as (
        table: unknown,
      ) => InsertBuilder;
      return (table: unknown) => {
        const builder = insert.call(target, table);
        if (table !== turnPart) {
          return builder;
        }
        // The event-collector always calls `.values(...)` directly and
        // awaits the result without further chaining, so only that method
        // needs interception here.
        const originalValues = builder.values.bind(builder);
        return {
          values: async (values: unknown): Promise<unknown> => {
            try {
              return await originalValues(values);
            } catch (err) {
              if (pgErrorCode(err) !== PG_FOREIGN_KEY_VIOLATION) {
                turnPartPersistFailures.count += 1;
                log.error`turn_part insert failed: ${err instanceof Error ? err.message : String(err)} (cause: ${causeMessage(err)})`;
                throw err;
              }
              await sleep(RETRY_DELAY_MS);
              try {
                return await originalValues(values);
              } catch (retryErr) {
                turnPartPersistFailures.count += 1;
                log.error`turn_part insert lost after retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)} (cause: ${causeMessage(retryErr)})`;
                throw retryErr;
              }
            }
          },
        };
      };
    },
  }) as DB["db"];
}
