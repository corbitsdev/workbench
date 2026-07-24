import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AppPageChromeRow } from "@workbench/ui";
import { useSetPageChrome } from "../lib/page-chrome";
import { Link, useLocation } from "react-router";
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
import { AutoApprovedToolsPanel } from "../components/AutoApprovedToolsPanel";
import { MyraDefaultsPanel } from "../components/MyraDefaultsPanel";
import { MyraInstructionsPanel } from "../components/MyraInstructionsPanel";
import { MyraStylePanel } from "../components/MyraStylePanel";
import { MyraPinnedSkillsPanel } from "../components/MyraPinnedSkillsPanel";
import { MyraToolsPanel } from "../components/MyraToolsPanel";
import { MyraInferenceDialsPanel } from "../components/MyraInferenceDialsPanel";
import { MORNING_BRIEF_ANCHOR_ID } from "./settings-section-nav";
import { useMyraVoiceInput } from "../hooks/use-myra-voice-input";
import { isFeatureEnabled, useMeFeatures } from "../hooks/use-me-features";

function buildSections(
  voiceInputCapabilityEnabled: boolean,
): SettingsSectionDescriptor[] {
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
        ...(voiceInputCapabilityEnabled
          ? [
              {
                key: "myraVoiceInput",
                label: "Voice input in Myra",
                kind: "toggle" as const,
                description:
                  "Show the microphone control in the Myra composer to dictate messages. Uses the browser speech service (Chrome/Edge work best; Brave may block it).",
              },
            ]
          : []),
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
    capabilityEnabled: myraVoiceCapabilityEnabled,
    enabled: myraVoiceInput,
    setEnabled: setMyraVoiceInput,
  } = useMyraVoiceInput();
  const features = useMeFeatures();
  const schedulerEnabled = isFeatureEnabled(features.data, "scheduler");
  const sections = useMemo(
    () => buildSections(myraVoiceCapabilityEnabled),
    [myraVoiceCapabilityEnabled],
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

  // Rail links from a management page arrive as /settings#<anchor> via router
  // navigation, which (unlike a native same-page anchor click) does not scroll
  // on its own — bring the targeted section into view.
  useEffect(() => {
    const anchorId = location.hash.replace(/^#/, "");
    if (!anchorId) return;
    const el = document.getElementById(anchorId);
    el?.scrollIntoView({ block: "start" });
  }, [location.hash]);

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
    <div>
      <p className="mb-6 text-sm text-text-3">
        Manage your workbench preferences.
      </p>
      <div className="flex min-w-0 flex-1 flex-col gap-12">
        <SettingsGroup
          id="your-agent"
          title="Your agent"
          description="How Myra acts on your behalf."
        >
          <PreferencesPanel categories={["Agent"]} />
        </SettingsGroup>

        <SettingsGroup
          id="myra-defaults"
          title="Myra defaults"
          description="Pick which Myra definition powers your chat and inbox routines."
        >
          <MyraDefaultsPanel tenantId={activeTenantId} />
        </SettingsGroup>

        <SettingsGroup
          id="myra-instructions"
          title="Standing instructions"
          description="Guidance Myra follows on every reply — set once globally, and optionally override it for chat or inbox routines."
        >
          <MyraInstructionsPanel tenantId={activeTenantId} />
        </SettingsGroup>

        <SettingsGroup
          id="myra-style"
          title="Personality & style"
          description="Shape how Myra talks and works. Personality, emoji use, and UI type apply everywhere; artifact, tool, and skill usage can differ between chat and inbox routines."
        >
          <MyraStylePanel tenantId={activeTenantId} />
        </SettingsGroup>

        <SettingsGroup
          id="myra-pinned-skills"
          title="Pinned skills"
          description="Pin procedures from your skill library so Myra sees an index of them when starting new chats or inbox runs."
        >
          <MyraPinnedSkillsPanel tenantId={activeTenantId} />
        </SettingsGroup>

        <SettingsGroup
          id="myra-tools"
          title="Tools & integrations"
          description="Turn off catalog tool packages or individual tools for your Myra. You can only narrow what your workspace already allows."
        >
          <MyraToolsPanel tenantId={activeTenantId} />
        </SettingsGroup>

        <SettingsGroup
          id="myra-inference"
          title="Inference dials"
          description="Tune Creative and Thinking per surface. Controls shown depend on the model behind your selected Myra variant."
        >
          <MyraInferenceDialsPanel tenantId={activeTenantId} />
        </SettingsGroup>

        <SettingsGroup
          id="inbox-capabilities"
          title="Your inbox & brief"
          description={
            schedulerEnabled
              ? "What lands in your inbox, and when your morning brief arrives."
              : "What lands in your inbox."
          }
        >
          <div id={MORNING_BRIEF_ANCHOR_ID} className="scroll-mt-4">
            <PreferencesPanel categories={["Routines"]} />
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
          id="auto-approved-actions"
          title="Always-approved actions"
          description="Actions you chose to stop being asked about. Revoke one to require approval again."
        >
          <AutoApprovedToolsPanel tenantId={activeTenantId} />
        </SettingsGroup>

        {schedulerEnabled && (
          <SettingsGroup
            id="schedules"
            title="Schedules"
            description="Scheduled and live workflows live on the Workflows page — pause, retime, create, and inspect them there."
          >
            <Link
              to="/workflows"
              data-testid="settings-open-workflows"
              className="inline-flex items-center gap-1 text-[13px] font-medium text-orange underline-offset-2 hover:underline"
            >
              Open Workflows →
            </Link>
          </SettingsGroup>
        )}

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
  );
}
