const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const SHORT_DATE_WITH_YEAR_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Short calendar date ("Jan 5" / "Jan 5, 2026") pinned to UTC so the label
 * is identical for every viewer regardless of local timezone. Use for
 * date-only labels where a stable, cross-user value matters more than
 * matching the viewer's local calendar day.
 */
export function formatShortDateUtc(
  value: string | Date,
  options: { includeYear?: boolean } = {},
): string {
  const date = toDate(value);
  const formatter = options.includeYear
    ? SHORT_DATE_WITH_YEAR_FORMATTER
    : SHORT_DATE_FORMATTER;
  return formatter.format(date);
}

/**
 * Short calendar date range ("Jan 5 – Feb 3, 2026"), UTC-pinned per
 * {@link formatShortDateUtc}. The end date always includes the year.
 */
export function formatShortDateRangeUtc(
  from: string | Date,
  to: string | Date,
): string {
  const fromDate = toDate(from);
  const toDateValue = toDate(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDateValue.getTime())) {
    return `${from}–${to}`;
  }
  return `${SHORT_DATE_FORMATTER.format(fromDate)} – ${SHORT_DATE_WITH_YEAR_FORMATTER.format(toDateValue)}`;
}

/**
 * Medium date + short time in the viewer's local timezone
 * ("Jan 5, 2026, 3:45 PM"), via `Intl.DateTimeFormat`'s `dateStyle`/`timeStyle`
 * presets. Use for "created at" / "updated at" style timestamps.
 */
export function formatDateTimeMedium(value: string | Date): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * Full timestamp including seconds, in the viewer's local timezone
 * ("Jan 5, 2026, 03:45:12 PM"). Use for detail views that need
 * second-level precision.
 */
export function formatFullTimestamp(value: string | Date): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Time-only label in the viewer's local timezone ("3:45 PM").
 */
export function formatTimeOnly(value: string | Date): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Absolute UTC timestamp with no locale dependency
 * ("2026-01-05 15:04 UTC"). Use where every viewer must see byte-identical
 * text regardless of locale or timezone (e.g. deploy/version timestamps).
 */
export function formatAbsoluteUtc(value: string | Date): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * Compact "just now / 5m ago / 3h ago / 2d ago" relative label, uncapped.
 * `now` is injectable for deterministic tests and callers that already
 * have a shared "now" reference.
 */
export function formatRelativeTime(
  value: string | Date,
  now: Date = new Date(),
): string {
  const then = toDate(value).getTime();
  const diffMs = now.getTime() - then;
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Humanized elapsed duration ("450ms" / "3.2s" / "1m 05s").
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}
