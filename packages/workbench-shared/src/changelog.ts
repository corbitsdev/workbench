import { type } from "arktype";

/**
 * The "what's new" changelog: a hand-maintained, additive list of releases
 * shown in the bottom pop-up, the walkthrough dialog, and the Settings page.
 * A new release is a single additive entry here. New `entry.to` paths must also
 * be added to `CHANGELOG_NAV_ROUTES` and covered by `router.deep-link.test.tsx`.
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

/**
 * Allowed `entry.to` targets for "Take me there" in the what's-new dialog.
 * Must match a route in `apps/web/src/router.tsx` (see `router.deep-link.test.tsx`).
 */
export const CHANGELOG_NAV_ROUTES = [
  "/inbox",
  "/chats",
  "/artifacts",
  "/settings",
  "/settings/owner/capabilities",
] as const;

// Newest first.
export const CHANGELOG: readonly ChangelogRelease[] = [
  {
    version: "0.8.3",
    date: "2026-07-19",
    title: "Under-the-hood upgrade",
    entries: [
      {
        title: "Performance and bug fixes",
        description:
          "Chats reload their full history reliably, web-search tools connect without hiccups, and the platform runtime moved to its latest version. No workflow changes needed on your side.",
      },
    ],
  },
  {
    version: "0.8.0",
    date: "2026-07-19",
    title: "A clearer, faster workbench",
    entries: [
      {
        title: "A gallery that shows your work",
        description:
          "Artifact cards lead with the content itself — image previews, document excerpts, and comparison verdicts on clean, minimal cards.",
        to: "/artifacts",
      },
      {
        title: "Images everywhere",
        description:
          "Pictures you share in chat now display as pictures — in the gallery and on the artifact page.",
        to: "/artifacts",
      },
      {
        title: "The agent library",
        description:
          "The Agents page now shows every agent available to you, along with the ones you have deployed.",
      },
      {
        title: "Skills with real names",
        description:
          "Skills show proper titles everywhere instead of technical file names.",
      },
      {
        title: "More room to chat",
        description:
          "The chat page gives the whole screen to your conversation, with thread details tucked into the top bar.",
        to: "/chats",
      },
      {
        title: "Voice input, owner-controlled",
        description:
          "Owners can turn on voice dictation for chat from the Capabilities page.",
        to: "/settings/owner/capabilities",
      },
      {
        title: "Performance and bug fixes",
        description:
          "Faster agent startup, more reliable workflows and daily briefs, and accurate token reporting are all included in this release.",
      },
    ],
  },
  {
    version: "0.7.6",
    date: "2026-07-16",
    title: "Make Myra your own",
    entries: [
      {
        title: "Custom instructions",
        description:
          "Tell Myra how you want her to work, and she carries your guidance into every chat.",
        to: "/settings",
      },
      {
        title: "Myra variants",
        description:
          "Pick the Myra that fits the job — each variant brings its own prompt and model.",
        to: "/settings",
      },
      {
        title: "Personalization controls",
        description:
          "Choose which tools and skills Myra reaches for, and set your own response style.",
        to: "/settings",
      },
      {
        title: "One settings home",
        description:
          "Preferences, workbench, and owner controls now live on a single page that shows you only what your role can change.",
        to: "/settings",
      },
      {
        title: "Faster, cleaner chat",
        description:
          "New chats open instantly and empty, with real titles and no waiting banner.",
        to: "/chats",
      },
      {
        title: "Image artifacts",
        description:
          "Images from your workflows preview as images in the gallery and on the artifact page.",
        to: "/artifacts",
      },
    ],
  },
  {
    version: "0.6.96",
    date: "2026-07-14",
    title: "Polish: inbox, settings, and what's new",
    entries: [
      {
        title: "What's new links",
        description:
          "Take me there from the release walkthrough now opens real app pages, including Myra at Chats.",
        to: "/chats",
      },
      {
        title: "Settings navigation",
        description:
          "The section menu stays visible on large screens while you scroll through preferences.",
        to: "/settings",
      },
      {
        title: "Inbox layout",
        description:
          "Tighter spacing and consistent control sizes across the inbox rail, Now feed, and tasks.",
        to: "/inbox",
      },
      {
        title: "Myra voice input",
        description:
          "Turn voice dictation on or off in Settings when your deployment supports it.",
        to: "/settings",
      },
    ],
  },
  {
    version: "0.6.95",
    date: "2026-07-14",
    title: "Inbox-led GTM workspace (owner setup required for automations)",
    entries: [
      {
        title: "Inbox home and Now feed",
        description:
          "Workbench opens on your inbox with a prioritized Now feed. Live intake, triage, and scheduled automations only run after your owner enables them — see Settings for what is available to you.",
        to: "/inbox",
      },
      {
        title: "Native tasks and notifications",
        description:
          "Tasks and workflow completion mail live in Workbench when your workspace has them enabled.",
        to: "/inbox",
      },
      {
        title: "Myra chat upgrades",
        description:
          "Multi-thread chat, generative UI blocks, paste and attachments, and a rebuilt activity transcript.",
        to: "/chats",
      },
      {
        title: "Artifacts gallery and detail",
        description:
          "Richer previews and a rebuilt artifact detail experience for workflow outputs.",
        to: "/artifacts",
      },
      {
        title: "Owner capabilities",
        description:
          "Owners configure inbox sources, automation features, and API keys from Capabilities before members see external intake or auto-triage.",
        to: "/settings/owner/capabilities",
      },
    ],
  },
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
