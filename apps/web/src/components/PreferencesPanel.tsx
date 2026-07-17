import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Select, Toggle } from "@workbench/settings";
import {
  briefSourcePreferenceKey,
  inboxSourcePreferenceKey,
  PREFERENCE_CATEGORIES,
  type PreferenceCategory,
  type PreferenceSetting,
} from "@workbench/shared";
import { cn, formatTimeOnly } from "@workbench/ui";
import {
  usePreferenceSettings,
  useUpdatePreference,
} from "../hooks/use-preference-settings";
import { useWorkflowsCatalog } from "../hooks/use-workflows-catalog";
import { useMeConnections } from "../hooks/use-me-connections";
import { isFeatureEnabled, useMeFeatures } from "../hooks/use-me-features";
import { BriefSourcesToggles } from "./BriefSourcesToggles";
import { InboxSourcesToggles } from "./InboxSourcesToggles";
import { BriefWorkflowAttachments } from "./BriefWorkflowAttachments";
import { SendBriefNowButton } from "./SendBriefNowButton";
import { useActiveWorkbench } from "../lib/active-workbench-context";

const BRIEF_SOURCE_KEY_PREFIX = briefSourcePreferenceKey("");
const INBOX_SOURCE_KEY_PREFIX = inboxSourcePreferenceKey("");

/**
 * Whether a setting's backing signal is met, given the loaded deployed-
 * workflow-kinds, connected-provider, and feature-enablement sets. A setting
 * with no `availableWhen` is always available (backward compatible). While the
 * relevant signal source is still loading, the setting is treated as
 * unavailable — hidden rather than flashing on then off once the real
 * answer arrives. `capability` has no wired projection endpoint yet (see
 * CL-3452 PR notes), so it never hides a control.
 *
 * `tasksAutoSendAdapter` is additionally gated on an Attio connection (the
 * CRM use case named in its copy) because `availableWhen` is a single signal
 * and the owner feature grant is the primary kill switch (CL-3823).
 */
function isSettingAvailable(
  setting: PreferenceSetting,
  deployedWorkflowKinds: ReadonlySet<string>,
  workflowsPending: boolean,
  connectedProviders: ReadonlySet<string>,
  connectionsPending: boolean,
  enabledFeatures: ReadonlySet<string>,
  featuresPending: boolean,
): boolean {
  const signal = setting.availableWhen;
  if (!signal) return true;
  if (signal.kind === "workflow-deployed") {
    if (workflowsPending) return false;
    return deployedWorkflowKinds.has(signal.workflowKind);
  }
  if (signal.kind === "credential-connected") {
    if (connectionsPending) return false;
    return connectedProviders.has(signal.provider);
  }
  if (signal.kind === "feature-enabled") {
    if (featuresPending) return false;
    if (!enabledFeatures.has(signal.feature)) return false;
    // Secondary Attio gate for the CRM auto-send toggle (see registry comment).
    if (setting.key === "tasksAutoSendAdapter") {
      if (connectionsPending) return false;
      return connectedProviders.has("attio");
    }
    return true;
  }
  return true;
}

type PreferenceValue = boolean | string | number;

/** Labels a UTC hour as the caller's local time (e.g. 13 → "9:00 AM"). */
function utcHourToLocalLabel(utcHour: number): string {
  const date = new Date();
  date.setUTCHours(utcHour, 0, 0, 0);
  return formatTimeOnly(date);
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

const TIMEZONE_UNSET_LABEL = "Not set (UTC)";

/**
 * IANA zone picker. Unset renders as an explicit "Not set (UTC)" option and,
 * when the browser can name the member's zone, a one-click suggestion — a
 * suggestion only: nothing is saved until the member confirms by clicking it
 * or picking a zone from the list.
 */
function TimeZoneControl({
  controlId,
  label,
  value,
  onChange,
}: {
  readonly controlId: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const zones = Intl.supportedValuesOf("timeZone");
  const options =
    zones.includes(value) || value === "" ? zones : [value, ...zones];
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const showSuggestion =
    value === "" && browserZone !== "" && zones.includes(browserZone);
  return (
    <>
      <Select
        id={controlId}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{TIMEZONE_UNSET_LABEL}</option>
        {options.map((zone) => (
          <option key={zone} value={zone}>
            {zone}
          </option>
        ))}
      </Select>
      {showSuggestion && (
        <button
          type="button"
          className="self-start text-xs text-accent hover:underline"
          onClick={() => onChange(browserZone)}
        >
          Use {browserZone}
        </button>
      )}
    </>
  );
}

interface RowProps {
  readonly setting: PreferenceSetting;
  readonly status: string | null;
  readonly onChange: (value: PreferenceValue) => void;
}

function PreferenceRow({ setting, status, onChange }: RowProps) {
  const controlId = `preference-${setting.key}`;
  return (
    <div
      data-tour={`preference-${setting.key}`}
      className="flex flex-col gap-1.5 border-b border-border py-3 last:border-b-0"
    >
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={controlId} className="text-sm font-medium text-text">
          {setting.label}
        </label>
        <div className="flex items-center gap-2">
          <AnimatePresence>
            {status !== null && (
              <motion.span
                key={status}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className={cn(
                  "text-xs",
                  status === "Couldn't save" ? "text-red" : "text-text-3",
                )}
              >
                {status}
              </motion.span>
            )}
          </AnimatePresence>
          {setting.type === "boolean" && (
            <Toggle
              id={controlId}
              aria-label={setting.label}
              checked={setting.value === true}
              onCheckedChange={(checked) => onChange(checked)}
            />
          )}
        </div>
      </div>

      {setting.type === "select" && (
        <Select
          id={controlId}
          value={typeof setting.value === "string" ? setting.value : ""}
          onChange={(event) => onChange(event.target.value)}
        >
          {(setting.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      )}

      {setting.type === "timezone" && (
        <TimeZoneControl
          controlId={controlId}
          label={setting.label}
          value={typeof setting.value === "string" ? setting.value : ""}
          onChange={(value) => onChange(value)}
        />
      )}

      {setting.type === "hourUtc" && (
        <>
          <Select
            id={controlId}
            value={
              typeof setting.value === "number" ? String(setting.value) : "13"
            }
            onChange={(event) => onChange(Number(event.target.value))}
          >
            {HOURS.map((h) => (
              <option key={h} value={String(h)}>
                {utcHourToLocalLabel(h)}
              </option>
            ))}
          </Select>
          <p className="text-xs text-text-3">Shown in your local time.</p>
        </>
      )}

      <p className="text-xs text-text-3">{setting.description}</p>
    </div>
  );
}

interface SectionProps {
  readonly category: PreferenceCategory;
  readonly settings: readonly PreferenceSetting[];
  readonly statusFor: (key: string) => string | null;
  readonly onChange: (
    setting: PreferenceSetting,
    value: PreferenceValue,
  ) => void;
  readonly reduceMotion: boolean;
  readonly index: number;
  /** When false, morning-brief extras under Automations are omitted (CL-3823). */
  readonly schedulerEnabled: boolean;
}

function PreferenceSection({
  category,
  settings,
  statusFor,
  onChange,
  reduceMotion,
  index,
  schedulerEnabled,
}: SectionProps) {
  const { activeTenantId } = useActiveWorkbench();
  return (
    <motion.section
      aria-labelledby={`preference-section-${category}`}
      initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: reduceMotion ? 0 : 0.25,
        delay: reduceMotion ? 0 : index * 0.05,
      }}
      className="rounded-xl border border-border bg-surface p-5"
    >
      <h2
        id={`preference-section-${category}`}
        className="mb-2 text-base font-semibold text-text"
      >
        {category}
      </h2>
      <div>
        {settings.map((setting) => (
          <PreferenceRow
            key={setting.key}
            setting={setting}
            status={statusFor(setting.key)}
            onChange={(value) => onChange(setting, value)}
          />
        ))}
      </div>
      {category === "Automations" && schedulerEnabled && (
        <>
          <BriefSourcesToggles />
          <BriefWorkflowAttachments tenantId={activeTenantId} />
          <SendBriefNowButton />
        </>
      )}
      {category === "Inbox" && <InboxSourcesToggles />}
    </motion.section>
  );
}

interface PreferencesPanelProps {
  /** Restricts rendering to these categories; omit to render every category. */
  readonly categories?: readonly PreferenceCategory[];
}

export function PreferencesPanel({ categories }: PreferencesPanelProps = {}) {
  const query = usePreferenceSettings();
  const update = useUpdatePreference();
  const reduceMotion = useReducedMotion() ?? false;
  const { activeTenantId } = useActiveWorkbench();
  const workflowsCatalog = useWorkflowsCatalog(activeTenantId);
  const connections = useMeConnections();
  const features = useMeFeatures();

  const deployedWorkflowKinds = new Set(
    (workflowsCatalog.data?.entries ?? []).map((entry) => entry.kind),
  );
  const connectedProviders = new Set(
    (connections.data?.connections ?? [])
      .filter((connection) => connection.connected)
      .map((connection) => connection.provider),
  );
  const enabledFeatures = new Set(
    (features.data?.features ?? []).filter((f) => f.enabled).map((f) => f.name),
  );
  const schedulerEnabled = isFeatureEnabled(features.data, "scheduler");

  const statusFor = (key: string): string | null => {
    if (update.variables?.key !== key) return null;
    if (update.isPending) return "Saving…";
    if (update.isError) return "Couldn't save";
    if (update.isSuccess) return "Saved";
    return null;
  };

  const handleChange = (setting: PreferenceSetting, value: PreferenceValue) => {
    update.mutate({ key: setting.key, value });
  };

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-6">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-32 animate-pulse rounded-xl border border-border bg-surface"
          />
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="rounded-xl border border-border bg-surface p-5">
        <p className="text-sm text-text-2">
          We couldn't load your preferences. Please refresh to try again.
        </p>
      </div>
    );
  }

  const settings = query.data;
  if (settings.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-5">
        <p className="text-sm text-text-2">No preferences to configure yet.</p>
      </div>
    );
  }

  // Brief-source and inbox-source toggles are rendered by
  // BriefSourcesToggles / InboxSourcesToggles (driven by
  // GET /me/brief-sources and GET /me/inbox-sources, which hide unconfigured
  // sources); excluded here to avoid a second, credential-unaware toggle for
  // the same keys.
  const visibleCategories = categories ?? PREFERENCE_CATEGORIES;
  const grouped = visibleCategories
    .map((category) => ({
      category,
      items: settings.filter(
        (s) =>
          s.category === category &&
          !s.key.startsWith(BRIEF_SOURCE_KEY_PREFIX) &&
          !s.key.startsWith(INBOX_SOURCE_KEY_PREFIX) &&
          isSettingAvailable(
            s,
            deployedWorkflowKinds,
            workflowsCatalog.isPending,
            connectedProviders,
            connections.isPending,
            enabledFeatures,
            features.isPending,
          ),
      ),
    }))
    .filter((group) => {
      if (group.items.length > 0) return true;
      if (group.category === "Inbox") return true;
      // Keep Automations only when morning-brief extras will render.
      if (group.category === "Automations" && schedulerEnabled) return true;
      return false;
    });

  return (
    <div className="flex flex-col gap-6">
      {grouped.map((group, index) => (
        <PreferenceSection
          key={group.category}
          category={group.category}
          settings={group.items}
          statusFor={statusFor}
          onChange={handleChange}
          reduceMotion={reduceMotion}
          index={index}
          schedulerEnabled={schedulerEnabled}
        />
      ))}
    </div>
  );
}
