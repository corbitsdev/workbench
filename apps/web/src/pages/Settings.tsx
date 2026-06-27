import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  SettingsPage,
  type SettingsFieldValue,
  type SettingsSectionDescriptor,
  type SettingsValues,
} from "@workbench/settings";
import {
  isTheme,
  useTheme,
  useCompactToolActivity,
  useExperimentalArtifactCards,
  useToolSummaryStyle,
  THEMES,
  THEME_LABELS,
} from "@workbench/ui";
import {
  summarizeToolCalls,
  isToolSummaryStyle,
  TOOL_SUMMARY_STYLES,
  TOOL_SUMMARY_STYLE_LABELS,
  TOOL_SUMMARY_PREVIEW_CALLS,
} from "@workbench/agents/browser";
import { api, fetchBuildSha } from "../lib/api";

const SECTIONS: readonly SettingsSectionDescriptor[] = [
  {
    id: "profile",
    title: "Profile",
    description: "How you appear across the workbench.",
    fields: [
      {
        key: "displayName",
        label: "Display name",
        kind: "text",
        placeholder: "Your name",
      },
    ],
  },
  {
    id: "notifications",
    title: "Notifications",
    fields: [
      {
        key: "emailNotifications",
        label: "Email notifications",
        kind: "toggle",
        description: "Receive a summary when a workflow finishes.",
      },
    ],
  },
  {
    id: "appearance",
    title: "Appearance",
    fields: [
      {
        key: "theme",
        label: "Theme",
        kind: "select",
        options: THEMES.map((t) => ({ value: t, label: THEME_LABELS[t] })),
      },
      {
        key: "compactToolActivity",
        label: "Compact tool activity",
        kind: "toggle",
        description:
          "Collapse a turn's tool calls into a single summary line you can expand.",
      },
      {
        key: "toolSummaryStyle",
        label: "Tool summary style",
        kind: "select",
        description:
          "How the collapsed summary line reads. Applies when compact tool activity is on.",
        options: TOOL_SUMMARY_STYLES.map((s) => ({
          value: s,
          label: TOOL_SUMMARY_STYLE_LABELS[s],
        })),
      },
      {
        key: "experimentalArtifactCards",
        label: "Experimental artifact cards",
        kind: "toggle",
        description:
          "Preview calmer, higher-contrast artifact cards before they become the default.",
      },
    ],
  },
];

const INITIAL_VALUES: SettingsValues = {
  displayName: "",
  emailNotifications: false,
};

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const { compact: compactToolActivity, setCompact: setCompactToolActivity } =
    useCompactToolActivity();
  const {
    enabled: experimentalArtifactCards,
    setEnabled: setExperimentalArtifactCards,
  } = useExperimentalArtifactCards();
  const { style: toolSummaryStyle, setStyle: setToolSummaryStyle } =
    useToolSummaryStyle();
  const [values, setValues] = useState<SettingsValues>({ ...INITIAL_VALUES });
  const [savedDisplayName, setSavedDisplayName] = useState<string>("");
  const buildShaQuery = useQuery({
    queryKey: ["version", "buildSha"],
    queryFn: fetchBuildSha,
    staleTime: 5 * 60_000,
  });

  const saveMutation = useMutation({
    mutationFn: async (name: string) => {
      await api("PATCH", "/me/profile", { displayName: name });
      return name;
    },
    onSuccess: (name) => setSavedDisplayName(name),
  });

  const handleChange = (key: string, value: SettingsFieldValue) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    if (key === "theme" && isTheme(value)) {
      setTheme(value);
    }
    if (key === "compactToolActivity" && typeof value === "boolean") {
      setCompactToolActivity(value);
    }
    if (key === "toolSummaryStyle" && isToolSummaryStyle(value)) {
      setToolSummaryStyle(value);
    }
    if (key === "experimentalArtifactCards" && typeof value === "boolean") {
      setExperimentalArtifactCards(value);
    }
    if (key === "displayName") {
      saveMutation.reset();
    }
  };

  const displayNameDirty =
    typeof values.displayName === "string" &&
    values.displayName !== savedDisplayName;

  // Show the 7-char short SHA in the UI; the API contract keeps the full value.
  const fullSha = buildShaQuery.isSuccess ? buildShaQuery.data : null;
  const buildLabel = fullSha ? fullSha.slice(0, 7) : "unknown";

  const handleSaveDisplayName = () => {
    const name =
      typeof values.displayName === "string" ? values.displayName.trim() : "";
    if (!name) return;
    saveMutation.mutate(name);
  };

  return (
    <div className="h-full overflow-y-auto">
      <SettingsPage
        sections={SECTIONS}
        values={{
          ...values,
          theme,
          compactToolActivity,
          toolSummaryStyle,
          experimentalArtifactCards,
        }}
        onChange={handleChange}
        description="Manage your workbench preferences."
      />
      <div
        className={`mx-auto w-full max-w-2xl px-4 pb-6${compactToolActivity ? "" : " opacity-50"}`}
      >
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-text-3">
          Example
          {!compactToolActivity && " (turn on compact tool activity to use)"}
        </p>
        <p className="text-sm text-text-2">
          {summarizeToolCalls(TOOL_SUMMARY_PREVIEW_CALLS, toolSummaryStyle)}
        </p>
      </div>
      {displayNameDirty && (
        <div className="mx-auto w-full max-w-2xl px-4 pb-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSaveDisplayName}
              disabled={saveMutation.isPending}
              className="rounded-lg bg-orange px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-deep disabled:opacity-50"
            >
              {saveMutation.isPending ? "Saving…" : "Save display name"}
            </button>
            {saveMutation.isError && (
              <span className="text-sm text-red-500">
                Failed to save. Please try again.
              </span>
            )}
          </div>
        </div>
      )}
      {saveMutation.isSuccess && (
        <div className="mx-auto w-full max-w-2xl px-4 pb-4">
          <p className="text-sm text-green-600">Display name saved.</p>
        </div>
      )}
      <div className="mx-auto w-full max-w-2xl px-4 pb-6">
        {buildShaQuery.isPending ? (
          // Reserve the line's height while loading so settling the query
          // causes no layout shift.
          <p className="h-4 animate-pulse font-mono text-xs text-text-3">
            build …
          </p>
        ) : (
          // An unavailable SHA (null in local dev, an error, or an unexpected
          // shape) degrades to "build unknown" on purpose: this is an operator
          // diagnostic, not a user-facing failure, so it must never surface a
          // scary error.
          <p className="font-mono text-xs text-text-3">build {buildLabel}</p>
        )}
      </div>
    </div>
  );
}
