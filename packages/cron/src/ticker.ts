// Turns due cron schedules into mail. `SELECT ... FOR UPDATE SKIP LOCKED`
// means two tickers racing the same table split due rows rather than
// double-fire; a schedule that missed several ticks fires once for the
// most recent due minute, never once per missed tick.
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { nextCronFireAfter } from "./cron";
import { cronScheduleTable } from "./schema";

export type CronDb<TSchema extends Record<string, unknown> = Record<string, unknown>> =
  PostgresJsDatabase<TSchema>;

export type DeliverCronMail = (message: {
  to: string[];
  subject: string;
  body: string;
  from: string;
}) => Promise<void> | void;

export type CronSenderAddress = (tenantId: string) => string;

/** The system sender address a tenant's cron mail comes from. */
export const cronSenderAddress: CronSenderAddress = (tenantId) => `cron@${tenantId}.internal`;

export type CreateCronTickerOpts<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = {
  db: CronDb<TSchema>;
  deliver: DeliverCronMail;
  intervalMs: number;
  senderAddressFor?: CronSenderAddress;
};

export type CronTicker = {
  start(): void;
  stop(): void;
};

/** A freshly saved schedule is due at its first matching minute after
 * creation, not retroactively for every minute since the epoch. */
function isDue(
  row: { expression: string; lastFiredAt: Date | null; createdAt: Date },
  now: Date,
): boolean {
  const after = row.lastFiredAt ?? row.createdAt;
  try {
    return nextCronFireAfter(row.expression, after) <= now;
  } catch {
    // report-error-ignore: an expression with no fire in the lookahead
    // window is simply never due, not an operational failure.
    return false;
  }
}

async function tick<TSchema extends Record<string, unknown>>(
  db: CronDb<TSchema>,
  deliver: DeliverCronMail,
  senderAddressFor: CronSenderAddress,
) {
  await db.transaction(async (tx) => {
    const now = new Date();
    // Every row, locked against a concurrent ticker (SKIP LOCKED means two
    // tickers racing this table split the due rows rather than double-fire
    // any of them); which ones are actually due is a JS-side check because
    // "due" depends on parsing each row's own cron expression.
    const candidates = await tx
      .select()
      .from(cronScheduleTable)
      .for("update", { skipLocked: true });

    for (const row of candidates.filter((row) => isDue(row, now))) {
      await deliver({
        to: [row.toAddress],
        subject: row.subject,
        body: row.body,
        from: senderAddressFor(row.tenantId),
      });
      await tx
        .update(cronScheduleTable)
        .set({ lastFiredAt: now })
        .where(eq(cronScheduleTable.id, row.id));
    }
  });
}

/** Ticks every `intervalMs`, delivering each due schedule as mail. */
export function createCronTicker<TSchema extends Record<string, unknown>>(
  opts: CreateCronTickerOpts<TSchema>,
): CronTicker {
  const senderAddressFor = opts.senderAddressFor ?? cronSenderAddress;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;

  const runTick = () => {
    if (inFlight !== undefined) return;
    inFlight = tick(opts.db, opts.deliver, senderAddressFor).finally(() => {
      inFlight = undefined;
    });
  };

  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(runTick, opts.intervalMs);
    },
    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
