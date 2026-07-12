import type { PreferenceSetting } from "@workbench/shared";
import {
  useBriefSources,
  useInboxSources,
  usePreferenceSettings,
} from "../hooks/use-preference-settings";

function findValue(
  settings: readonly PreferenceSetting[],
  key: string,
): PreferenceSetting["value"] | undefined {
  return settings.find((s) => s.key === key)?.value;
}

function utcHourToLocalLabel(utcHour: number): string {
  const date = new Date();
  date.setUTCHours(utcHour, 0, 0, 0);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

interface FeedRowProps {
  readonly label: string;
  readonly status: string;
}

function FeedRow({ label, status }: FeedRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2.5 last:border-b-0">
      <span className="text-sm font-medium text-text">{label}</span>
      <span className="text-xs text-text-3">{status}</span>
    </div>
  );
}

/**
 * Read-only summary of everything that feeds a member's inbox and morning
 * brief: the always-on feeds (brief, mentions, approvals, task activity) and,
 * per external source in `GET /me/brief-sources` / `GET /me/inbox-sources`,
 * whether it feeds the brief, the inbox, and (when triage may create tasks)
 * whether it can leave a task behind. Renders nothing while loading or on
 * error — this is an informational panel, not a control surface, so a
 * transient failure degrades silently rather than showing a scary message.
 */
export function ConnectedToInboxPanel() {
  const settingsQuery = usePreferenceSettings();
  const briefSourcesQuery = useBriefSources();
  const inboxSourcesQuery = useInboxSources();

  if (
    settingsQuery.isPending ||
    briefSourcesQuery.isPending ||
    inboxSourcesQuery.isPending
  ) {
    return (
      <div className="h-40 animate-pulse rounded-xl border border-border bg-surface" />
    );
  }

  if (
    settingsQuery.isError ||
    briefSourcesQuery.isError ||
    inboxSourcesQuery.isError
  ) {
    return null;
  }

  const settings = settingsQuery.data;
  const briefHourUtc = findValue(settings, "briefHourUtc");
  const notifyGateAsks = findValue(settings, "notifyGateAsks") === true;
  const notifyInboxMail = findValue(settings, "notifyInboxMail") === true;
  const taskMailEnabled = findValue(settings, "taskMailEnabled") === true;
  const tasksTriageCreate = findValue(settings, "tasksTriageCreate") === true;

  const briefSources = briefSourcesQuery.data;
  const inboxSources = inboxSourcesQuery.data;

  const sourceKeys = Array.from(
    new Set([
      ...briefSources.map((s) => s.key),
      ...inboxSources.map((s) => s.key),
    ]),
  );

  if (sourceKeys.length === 0 && settings.length === 0) {
    return null;
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h3 className="mb-1 text-base font-semibold text-text">
        Connected to your inbox
      </h3>
      <p className="mb-3 text-xs text-text-3">
        What feeds your inbox and morning brief, and what can create tasks.
      </p>

      <div className="flex flex-col">
        <FeedRow
          label="Morning brief"
          status={
            typeof briefHourUtc === "number"
              ? `Daily at ${utcHourToLocalLabel(briefHourUtc)}`
              : "Scheduled"
          }
        />
        <FeedRow
          label="Mentions & new mail"
          status={notifyInboxMail ? "On" : "Off"}
        />
        <FeedRow
          label="Approvals & gates"
          status={notifyGateAsks ? "On" : "Off"}
        />
        <FeedRow
          label="Task activity"
          status={taskMailEnabled ? "On" : "Off"}
        />
      </div>

      {sourceKeys.length > 0 && (
        <div className="mt-4 flex flex-col gap-1 border-t border-border pt-4">
          <h4 className="mb-1 text-sm font-semibold text-text">
            External sources
          </h4>
          {tasksTriageCreate && (
            <p className="mb-1 text-xs text-text-3">
              Myra&apos;s triage may leave a task behind for actionable mail
              from any source in your inbox.
            </p>
          )}
          {sourceKeys.map((key) => {
            const brief = briefSources.find((s) => s.key === key);
            const inbox = inboxSources.find((s) => s.key === key);
            const label = inbox?.label ?? brief?.label ?? key;
            const description = inbox?.description ?? brief?.description ?? "";
            const feedsInbox = inbox?.enabled === true;
            const feedsBrief = brief?.enabled === true;
            const capabilities: string[] = [];
            if (feedsBrief) capabilities.push("brief");
            if (feedsInbox) capabilities.push("inbox");

            return (
              <div
                key={key}
                className="flex flex-col gap-1 border-b border-border py-2.5 last:border-b-0"
              >
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm font-medium text-text">{label}</span>
                  <span className="text-xs text-text-3">
                    {capabilities.length > 0
                      ? capabilities.join(" · ")
                      : "Not connected"}
                  </span>
                </div>
                {description !== "" && (
                  <p className="text-xs text-text-3">{description}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
