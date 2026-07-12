import { useState } from "react";
import { CHANGELOG, latestChangelogRelease } from "@workbench/shared";
import { useMarkChangelogSeen } from "../../hooks/use-changelog";
import { WhatsNewDialog } from "./WhatsNewDialog";

/**
 * The Settings "What's new" section: every release, newest first, with a
 * "View walkthrough" affordance that reopens the same dialog the bottom
 * pop-up uses for the latest release. Mirrors `PreferencesPanel`'s
 * section-per-category structure at a smaller scale (one static section, no
 * server-driven registry).
 */
export function WhatsNewSection() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const markSeen = useMarkChangelogSeen();
  const latest = latestChangelogRelease();

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-text">What's new</h2>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="text-sm font-medium text-orange transition-colors hover:text-orange-deep"
        >
          View walkthrough
        </button>
      </div>

      <div className="flex flex-col gap-5">
        {CHANGELOG.map((release) => (
          <div key={release.version}>
            <p className="text-sm font-semibold text-text">
              {release.version} · {release.date}
            </p>
            <p className="text-xs text-text-3">{release.title}</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {release.entries.map((entry) => (
                <li key={entry.title} className="text-xs text-text-2">
                  <span className="font-medium text-text">{entry.title}</span>
                  {" — "}
                  {entry.description}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {dialogOpen && (
        <WhatsNewDialog
          release={latest}
          onClose={() => setDialogOpen(false)}
          onDone={markSeen}
        />
      )}
    </div>
  );
}
