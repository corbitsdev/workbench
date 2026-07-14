import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AppPageChromeRow } from "@workbench/ui";
import { useSetPageChrome } from "../lib/page-chrome";
import { useLocation } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { LogOut } from "lucide-react";
import { fetchBuildSha } from "../lib/api";
import { getMe, patchMeProfile } from "../lib/hub-api";
import { useAuth } from "../components/AuthProvider";
import { PreferencesPanel } from "../components/PreferencesPanel";
import { ConnectedToInboxPanel } from "../components/ConnectedToInboxPanel";
import { useTourLauncher } from "../components/tour/OnboardingTour";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { WhatsNewSection } from "../components/whats-new/WhatsNewSection";
import { MemberConnectionsPanel } from "../components/MemberConnectionsPanel";
import { MySchedules } from "../components/MySchedules";
import { SettingsSectionNav } from "./SettingsSectionNav";
import { MORNING_BRIEF_ANCHOR_ID } from "./settings-section-nav";
import { useMyraVoiceInput } from "../hooks/use-myra-voice-input";

function buildSections(myraVoiceBuildEnabled: boolean): SettingsSectionDescriptor[] {
  return [
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
        {
          key: "myraVoiceInput",
          label: "Voice input in Myra",
          kind: "toggle",
          disabled: !myraVoiceBuildEnabled,
          description: myraVoiceBuildEnabled
            ? "Show the microphone control in the Myra composer to dictate messages."
            : "Not available in this build. Deploy with VITE_MYRA_VOICE_INPUT enabled to use voice dictation.",
        },
      ],
    },
  ];
}

const INITIAL_VALUES: SettingsValues = {};

interface SettingsGroupProps {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}

function SettingsGroup({
  id,
  title,
  description,
  children,
}: SettingsGroupProps) {
  return (
    <section id={id} className="scroll-mt-4">
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-text">{title}</h2>
        {description !== undefined && (
          <p className="mt-0.5 text-sm text-text-3">{description}</p>
        )}
      </div>
      <div className="flex flex-col gap-6">{children}</div>
    </section>
  );
}

export default function Settings() {
  const location = useLocation();
  const { activeTenantId } = useActiveWorkbench();
  const { signOut } = useAuth();
  const { startTour } = useTourLauncher();
  const { theme, setTheme } = useTheme();
  const { compact: compactToolActivity, setCompact: setCompactToolActivity } =
    useCompactToolActivity();
  const {
    enabled: experimentalArtifactCards,
    setEnabled: setExperimentalArtifactCards,
  } = useExperimentalArtifactCards();
  const { style: toolSummaryStyle, setStyle: setToolSummaryStyle } =
    useToolSummaryStyle();
  const {
    buildEnabled: myraVoiceBuildEnabled,
    enabled: myraVoiceInput,
    setEnabled: setMyraVoiceInput,
  } = useMyraVoiceInput();
  const sections = useMemo(
    () => buildSections(myraVoiceBuildEnabled),
    [myraVoiceBuildEnabled],
  );
  const queryClient = useQueryClient();
  const [values, setValues] = useState<SettingsValues>({ ...INITIAL_VALUES });
  // `undefined` means the field has not been touched this session, so it shows
  // the persisted name; a string is the user's in-progress edit.
  const [editedDisplayName, setEditedDisplayName] = useState<
    string | undefined
  >(undefined);
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60_000,
  });
  const savedDisplayName = meQuery.data?.userName ?? "";
  const displayName = editedDisplayName ?? savedDisplayName;
  const buildShaQuery = useQuery({
    queryKey: ["version", "buildSha"],
    queryFn: fetchBuildSha,
    staleTime: 5 * 60_000,
  });

  const saveMutation = useMutation({
    mutationFn: (name: string) => patchMeProfile(name),
    onSuccess: async () => {
      setEditedDisplayName(undefined);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    },
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
    if (key === "myraVoiceInput" && typeof value === "boolean") {
      setMyraVoiceInput(value);
    }
    if (key === "displayName" && typeof value === "string") {
      setEditedDisplayName(value);
      saveMutation.reset();
    }
  };

  const displayNameDirty =
    typeof editedDisplayName === "string" &&
    editedDisplayName.trim() !== "" &&
    editedDisplayName.trim() !== savedDisplayName;

  // Show the 7-char short SHA in the UI; the API contract keeps the full value.
  const fullSha = buildShaQuery.isSuccess ? buildShaQuery.data : null;
  const buildLabel = fullSha ? fullSha.slice(0, 7) : "unknown";

  const handleSaveDisplayName = () => {
    const name = displayName.trim();
    if (!name) return;
    saveMutation.mutate(name);
  };

  useEffect(() => {
    if (location.pathname !== "/settings/connections") return;
    const el = document.getElementById("connections");
    el?.scrollIntoView({ block: "start" });
  }, [location.pathname]);

  const pageChrome = useMemo(
    () => (
      <AppPageChromeRow
        title="Settings"
        titleSize="sm"
        className="[&_h1]:text-xl"
      />
    ),
    [],
  );
  useSetPageChrome(pageChrome);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-6">
        <p className="mb-6 text-sm text-text-3">
          Manage your workbench preferences.
        </p>
        <div className="flex flex-col gap-10 lg:flex-row lg:gap-8">
          <div className="lg:sticky lg:top-4 lg:self-start">
            <SettingsSectionNav />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-12">
            <SettingsGroup
              id="your-agent"
              title="Your agent"
              description="How Myra acts on your behalf."
            >
              <PreferencesPanel categories={["Agent"]} />
            </SettingsGroup>

            <SettingsGroup
              id="inbox-capabilities"
              title="Your inbox & brief"
              description="What lands in your inbox, and when your morning brief arrives."
            >
              <div id={MORNING_BRIEF_ANCHOR_ID} className="scroll-mt-4">
                <PreferencesPanel categories={["Automations"]} />
              </div>
              <PreferencesPanel categories={["Inbox", "Notifications"]} />
              <ConnectedToInboxPanel />
            </SettingsGroup>

            <SettingsGroup
              id="connections"
              title="Connections"
              description="Connect your accounts to bring outside data into the workbench."
            >
              <MemberConnectionsPanel />
            </SettingsGroup>

            <SettingsGroup
              id="schedules"
              title="Schedules"
              description="Workflows you've put on a daily cadence — pause, retime, or remove them here."
            >
              <MySchedules tenantId={activeTenantId} embedded />
            </SettingsGroup>

            <SettingsGroup id="account" title="Account">
              <PreferencesPanel categories={["General"]} />
              <div className="rounded-xl border border-border bg-surface p-5">
                <SettingsPage
                  title="Profile & appearance"
                  className="w-full max-w-none px-0 py-0"
                  sections={sections}
                  values={{
                    ...values,
                    displayName,
                    theme,
                    compactToolActivity,
                    toolSummaryStyle,
                    experimentalArtifactCards,
                    myraVoiceInput,
                  }}
                  onChange={handleChange}
                />
                {displayNameDirty && (
                  <div className="mt-4 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleSaveDisplayName}
                      disabled={saveMutation.isPending}
                      className="rounded-lg bg-orange px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-deep disabled:opacity-50"
                    >
                      {saveMutation.isPending ? "Saving…" : "Save display name"}
                    </button>
                    {saveMutation.isError && (
                      <span className="text-sm text-red">
                        Couldn't save. Try again.
                      </span>
                    )}
                  </div>
                )}
                {saveMutation.isSuccess && (
                  <p className="mt-4 text-sm text-green">Display name saved.</p>
                )}
                <div
                  className={`mt-4 border-t border-border pt-4${compactToolActivity ? "" : " opacity-50"}`}
                >
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-text-3">
                    Example
                    {!compactToolActivity &&
                      " (turn on compact tool activity to use)"}
                  </p>
                  <p className="text-sm text-text-2">
                    {summarizeToolCalls(
                      TOOL_SUMMARY_PREVIEW_CALLS,
                      toolSummaryStyle,
                    )}
                  </p>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-surface p-5">
                <button
                  type="button"
                  onClick={startTour}
                  className="rounded-[10px] border border-border bg-page px-3 py-2 text-sm text-text transition-colors hover:bg-surface"
                >
                  Take the tour
                </button>
                <p className="mt-1 text-xs text-text-3">
                  Replay the five-step introduction.
                </p>
              </div>

              <div className="rounded-xl border border-border bg-surface p-5">
                {buildShaQuery.isPending ? (
                  // Reserve the line's height while loading so settling the
                  // query causes no layout shift.
                  <p className="h-4 animate-pulse font-mono text-xs text-text-3">
                    build …
                  </p>
                ) : (
                  // An unavailable SHA (null in local dev, an error, or an
                  // unexpected shape) degrades to "build unknown" on purpose:
                  // this is an operator diagnostic, not a user-facing
                  // failure, so it must never surface a scary error.
                  <p className="font-mono text-xs text-text-3">
                    build {buildLabel}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border bg-page px-3 py-2 text-sm text-text transition-colors hover:bg-surface"
                >
                  <LogOut size={14} />
                  Sign out
                </button>
              </div>
            </SettingsGroup>

            <SettingsGroup id="whats-new" title="What's new">
              <WhatsNewSection />
            </SettingsGroup>
          </div>
        </div>
      </div>
    </div>
  );
}
