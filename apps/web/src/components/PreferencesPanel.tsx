import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Select, Toggle } from "@workbench/settings";
import {
  PREFERENCE_CATEGORIES,
  type PreferenceCategory,
  type PreferenceSetting,
} from "@workbench/shared";
import { cn } from "@workbench/ui";
import {
  usePreferenceSettings,
  useUpdatePreference,
} from "../hooks/use-preference-settings";
import { BriefWorkflowAttachments } from "./BriefWorkflowAttachments";
import { useActiveWorkbench } from "../lib/active-workbench-context";

type PreferenceValue = boolean | string | number;

/** Labels a UTC hour as the caller's local time (e.g. 13 → "9:00 AM"). */
function utcHourToLocalLabel(utcHour: number): string {
  const date = new Date();
  date.setUTCHours(utcHour, 0, 0, 0);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

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

      {setting.type === "hourUtc" && (
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
}

function PreferenceSection({
  category,
  settings,
  statusFor,
  onChange,
  reduceMotion,
  index,
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
      {category === "Automations" && (
        <BriefWorkflowAttachments tenantId={activeTenantId} />
      )}
    </motion.section>
  );
}

export function PreferencesPanel() {
  const query = usePreferenceSettings();
  const update = useUpdatePreference();
  const reduceMotion = useReducedMotion() ?? false;

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

  const grouped = PREFERENCE_CATEGORIES.map((category) => ({
    category,
    items: settings.filter((s) => s.category === category),
  })).filter((group) => group.items.length > 0);

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
        />
      ))}
    </div>
  );
}
