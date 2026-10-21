// Every schedule renders as a human sentence, never a raw cron expression
// (DESIGN.md Copy). Timezone is named only when there's a wall clock to
// read it in.
import { toString as describeCronExpression } from "cronstrue";

/** A cron field is unpinned when it matches every value in its range —
 * a bare star, or a star with a step (which pins a cadence, not a clock
 * reading). */
function fieldIsUnpinned(field: string): boolean {
  return /^\*(\/\d+)?$/.test(field);
}

/** True when the expression names a time of day, e.g. `0 9 * * *`, not a
 * step cadence like every 15 minutes. */
export function cronHasWallClock(expression: string): boolean {
  const [minute, hour] = expression.trim().split(/\s+/);
  if (minute === undefined || hour === undefined) return false;
  return !fieldIsUnpinned(minute) || !fieldIsUnpinned(hour);
}

/** A cron expression as an English sentence, or `null` when not
 * describable, so a caller can show the raw invalid input instead. */
export function cronSentence(expression: string, timezone: string = "UTC"): string | null {
  let described: string;
  try {
    described = describeCronExpression(expression, {
      verbose: false,
      use24HourTimeFormat: true,
      throwExceptionOnParseError: true,
    });
  } catch {
    // report-error-ignore: cronstrue parse failure is the invalid-input
    // signal; the caller shows the raw expression instead.
    return null;
  }
  if (described === "") return null;
  return cronHasWallClock(expression) ? `${described} (${timezone})` : described;
}
