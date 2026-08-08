// A minute-granularity matcher for the 5-field cron grammar
// `@corbits/routines`' `cronExpressionForTrigger` renders every trigger
// preset into (minute hour day-of-month month day-of-week), plus whatever
// a routine's raw-cron escape hatch supplies (already validated at save
// time by `isValidCronExpression`, the same grammar this matches). Kept
// as a pure function so the scheduler's "is it time yet" decision is
// exercised without a clock, a database, or a launch.
type CronClause = {
  readonly base: "*" | number;
  readonly step?: number;
  readonly rangeEnd?: number;
};

function parseClause(raw: string): CronClause {
  const match = /^(\*|[0-9]+)(?:\/([0-9]+))?(?:-([0-9]+))?$/.exec(raw);
  if (match === null) {
    throw new Error(`unrecognized cron field clause "${raw}"`);
  }
  const [, base, step, rangeEnd] = match;
  return {
    base: base === "*" ? "*" : Number(base),
    ...(step !== undefined ? { step: Number(step) } : {}),
    ...(rangeEnd !== undefined ? { rangeEnd: Number(rangeEnd) } : {}),
  };
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

function fieldMatches(field: string, value: number): boolean {
  return field
    .split(",")
    .some((clause) => clauseMatches(parseClause(clause), value));
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
