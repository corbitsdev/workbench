// The single 5-field cron grammar `@corbits/routines` speaks: one parser
// shared by validation (does this expression make sense at save time?)
// and execution (does this expression match this minute?). Before this
// module existed, `trigger.ts` and the hub's scheduler each hand-rolled
// their own field parser — format-only, no range checking, incompatible
// clause orderings — so an expression could validate as saveable and
// then never fire, or fire on one parser's reading and not the other's.
// One parser closes that gap: whatever validates here is exactly what
// matches here.
export type CronField =
  "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

/** Field order in a 5-field cron expression, paired with its valid range. */
export const CRON_FIELD_RANGES: Readonly<
  Record<CronField, readonly [number, number]>
> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6],
};

const CRON_FIELD_ORDER: readonly CronField[] = [
  "minute",
  "hour",
  "dayOfMonth",
  "month",
  "dayOfWeek",
];

type CronClause = {
  readonly base: "*" | number;
  readonly rangeEnd?: number;
  readonly step?: number;
};

// Standard cron clause order is base, then an optional range, then an
// optional step: `5`, `5-10`, `*/2`, `5-10/2`. Only this order is
// accepted — the reversed `5/2-10` idiom neither cron nor either of
// this repo's previous hand-rolled parsers meaningfully supported.
const CLAUSE_PATTERN = /^(\*|[0-9]+)(?:-([0-9]+))?(?:\/([0-9]+))?$/;

function parseCronClause(raw: string): CronClause | undefined {
  const match = CLAUSE_PATTERN.exec(raw);
  if (match === null) return undefined;
  const [, base, rangeEnd, step] = match;
  return {
    base: base === "*" ? "*" : Number(base),
    ...(rangeEnd !== undefined ? { rangeEnd: Number(rangeEnd) } : {}),
    ...(step !== undefined ? { step: Number(step) } : {}),
  };
}

/**
 * True when `clause` is meaningful for a field whose valid values span
 * `[min, max]`: every literal value in range, and — the case the old
 * format-only validators missed — a reversed range (`10-5`) rejected
 * rather than accepted as an expression that is syntactically fine and
 * unconditionally never true.
 */
function clauseInRange(
  clause: CronClause,
  [min, max]: readonly [number, number],
): boolean {
  if (clause.step !== undefined && clause.step <= 0) return false;
  if (clause.base === "*") return true;
  if (clause.base < min || clause.base > max) return false;
  if (clause.rangeEnd === undefined) return true;
  if (clause.rangeEnd < min || clause.rangeEnd > max) return false;
  return clause.rangeEnd >= clause.base;
}

function clauseMatches(clause: CronClause, value: number): boolean {
  if (clause.base === "*") {
    return clause.step === undefined ? true : value % clause.step === 0;
  }
  if (clause.rangeEnd === undefined && clause.step === undefined) {
    return value === clause.base;
  }
  const upper = clause.rangeEnd ?? clause.base;
  if (value < clause.base || value > upper) return false;
  if (clause.step === undefined) return true;
  return (value - clause.base) % clause.step === 0;
}

function everyClause(
  field: string,
  test: (clause: CronClause) => boolean,
): boolean {
  const clauses = field.split(",").map(parseCronClause);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => clause !== undefined && test(clause));
}

function someClause(
  field: string,
  test: (clause: CronClause) => boolean,
): boolean {
  return field.split(",").some((raw) => {
    const clause = parseCronClause(raw);
    return clause !== undefined && test(clause);
  });
}

/**
 * Loud, eager validation for a raw 5-field cron expression
 * (minute hour day-of-month month day-of-week): every field's syntax
 * AND every field's values must be sane for that position — a minute
 * of 60, a month of 13, or a reversed range all fail here, never
 * silently accepted only to fail at fire-time.
 */
export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => {
    const cronField = CRON_FIELD_ORDER[index];
    if (cronField === undefined) return false;
    return everyClause(field, (clause) =>
      clauseInRange(clause, CRON_FIELD_RANGES[cronField]),
    );
  });
}

function fieldMatches(field: string, value: number): boolean {
  return someClause(field, (clause) => clauseMatches(clause, value));
}

/**
 * True when `expression`'s minute/hour/day-of-month/month/day-of-week
 * fields all match `at` (read in UTC, matching how the trigger presets'
 * hour/minute fields are stored — no timezone concept exists yet on a
 * `RoutineTrigger`).
 */
export function cronMatchesMinute(expression: string, at: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    throw new Error(`"${expression}" is not a 5-field cron expression`);
  }
  return (
    fieldMatches(minute, at.getUTCMinutes()) &&
    fieldMatches(hour, at.getUTCHours()) &&
    fieldMatches(dayOfMonth, at.getUTCDate()) &&
    fieldMatches(month, at.getUTCMonth() + 1) &&
    fieldMatches(dayOfWeek, at.getUTCDay())
  );
}

/** The UTC minute `at` falls in, as a stable, comparable integer key. */
export function minuteKey(at: Date): number {
  return Math.floor(at.getTime() / 60_000);
}

/**
 * Bounds how far ahead `nextCronFireAfter` will search before giving up
 * — generous enough to reach a once-a-year fire (e.g. a specific
 * month/day) but not an unbounded loop over a typo'd expression that
 * (thanks to `isValidCronExpression`) can no longer be unconditionally
 * false forever.
 */
const MAX_LOOKAHEAD_MINUTES = 5 * 366 * 24 * 60;

/**
 * The next minute at or after `after` (exclusive) that `expression`
 * matches — the closed-form "when does this actually fire next"
 * calculation, used both to persist a routine's `nextFireAt` and to
 * render a UI's next-run estimate against the exact semantics that
 * fire it.
 */
export function nextCronFireAfter(expression: string, after: Date): Date {
  const start = minuteKey(after) + 1;
  for (let minute = start; minute - start <= MAX_LOOKAHEAD_MINUTES; minute++) {
    const candidate = new Date(minute * 60_000);
    if (cronMatchesMinute(expression, candidate)) return candidate;
  }
  throw new Error(
    `"${expression}" has no fire time within the lookahead window`,
  );
}
