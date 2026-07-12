import { type } from "arktype";

/**
 * The "what's new" changelog: a hand-maintained, additive list of releases
 * shown in the bottom pop-up, the walkthrough dialog, and the Settings page.
 * A new release is a single additive entry here — no other file changes.
 */

export const ChangelogEntrySchema = type({
  title: "string",
  description: "string",
  "to?": "string",
});
export type ChangelogEntry = typeof ChangelogEntrySchema.infer;

export const ChangelogReleaseSchema = type({
  version: "string",
  date: "string",
  title: "string",
  entries: ChangelogEntrySchema.array(),
});
export type ChangelogRelease = typeof ChangelogReleaseSchema.infer;

// Newest first.
export const CHANGELOG: readonly ChangelogRelease[] = [
  {
    version: "0.6.0",
    date: "2026-07-11",
    title: "Auto-run: your inbox does more of the work",
    entries: [
      {
        title: "Inbox home and the Now feed",
        description:
          "Workbench opens on your inbox, with a Now feed surfacing what needs your attention first.",
        to: "/inbox",
      },
      {
        title: "Live inbox updates",
        description:
          "New mail, tasks, and agent handoffs appear in your inbox the moment they land, no refresh needed.",
        to: "/inbox",
      },
      {
        title: "Morning brief and the brief composer",
        description:
          "Set when your morning brief arrives and which sources feed it from Settings.",
        to: "/settings",
      },
      {
        title: "Triage Myra",
        description:
          "Myra now triages incoming items for you, so you can act on what matters instead of sorting.",
      },
      {
        title: "Schedules",
        description:
          "Put recurring work on a schedule and let it run automatically.",
      },
      {
        title: "Native tasks and send-to-external",
        description:
          "Tasks live natively in Workbench, and you can send them out to external tools when work moves beyond it.",
      },
      {
        title: "Notifications bell",
        description:
          "A bell in the app frame keeps you posted on new mail and open tasks as they come in.",
      },
    ],
  },
];

export function latestChangelogVersion(): string {
  const [latest] = CHANGELOG;
  if (!latest) throw new Error("CHANGELOG must not be empty");
  return latest.version;
}

export function latestChangelogRelease(): ChangelogRelease {
  const [latest] = CHANGELOG;
  if (!latest) throw new Error("CHANGELOG must not be empty");
  return latest;
}

/**
 * Compares two `x.y.z` version strings. Returns a negative number when `a` is
 * older than `b`, positive when newer, `0` when equal. Missing/non-numeric
 * segments compare as `0`, so shorter strings ("0.6" vs "0.6.0") compare equal.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const partsB = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i += 1) {
    const segmentA = partsA[i] ?? 0;
    const segmentB = partsB[i] ?? 0;
    if (segmentA !== segmentB) return segmentA - segmentB;
  }
  return 0;
}

/** True when `seenVersion` is strictly older than the latest changelog version. */
export function hasUnseenChangelog(seenVersion: string): boolean {
  if (seenVersion === "") return true;
  return compareVersions(seenVersion, latestChangelogVersion()) < 0;
}
