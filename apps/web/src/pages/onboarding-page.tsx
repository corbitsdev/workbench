// First-run wizard: provision the account's one workbench under a
// default name derived from the account, add an inference credential,
// then get oriented. There is no naming step — CL-6089 collapsed the
// multi-bench model down to one workbench per account, so nothing is
// left to name. The heavy lifting — proving the key with a real call,
// seeding the bench, deploying and confirming every default workflow —
// happens server-side in `@workbench/onboarding`; this page is the
// guided shell around it. The credential step is skipped entirely
// (straight to the "your workbench is ready" ending) whenever the
// server reports the default workflow set already deployed and
// confirmed against a working credential — a hub-owned key (env-key
// auto-plant, CL-6101, or the older ANTHROPIC_API_KEY path) for a fresh
// bench, or a real working credential for a returning member. There is
// nothing left to prove or connect at that point, so there is nothing
// left to show.

import {
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  ProgressChecklist,
  ProviderMark,
} from "@corbits/react-ui";
import type { ChecklistStep } from "@corbits/react-ui";
import { DialogStepper } from "@corbits/chat-ui";
import type { DialogStepperStep } from "@corbits/chat-ui";
import {
  ConnectorCardGrid,
  listCredentials,
  listProviders,
} from "@corbits/settings-ui";
import type { Credential, Provider } from "@corbits/settings-ui";
import {
  AtSign,
  Bot,
  CircleAlert,
  KeyRound,
  MessageSquare,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { Link, useNavigate } from "../navigation";
import {
  completeSetup,
  CREDENTIAL_PROVIDERS,
  HUGGINGFACE_CONNECT_START_PATH,
  OPENROUTER_CONNECT_START_PATH,
  PRIMARY_CREDENTIAL_PROVIDERS,
  readHuggingFaceConnectReturn,
  readOpenRouterConnectReturn,
  SECONDARY_CREDENTIAL_PROVIDERS,
  submitCredential,
  triggerFirstLoginProvisioning,
} from "../onboarding";
import type { CredentialProvider, CredentialProviderCard } from "../onboarding";
import { OnboardingLayout } from "../onboarding/onboarding-layout";
import type { SessionUser } from "../session";

/** No naming step means provisioning always needs a name to send — this
 * derives one from the account so `/api/onboarding/provision` never gets
 * called bare. Prefers the account's display name; an account with no
 * usable name falls back to the email's local part. Editable later from
 * Settings, same as any other display name. */
function defaultWorkbenchName(user: SessionUser): string {
  const source =
    user.name.trim().length > 0 ? user.name.trim() : user.email.split("@")[0];
  return `${source || "Your"}'s workbench`;
}

const GUIDANCE_CARDS = [
  {
    icon: <MessageSquare />,
    title: "Workbenches",
    description:
      "A workbench is a conversation with an agent — yours to talk to, 1:1 or with your team alongside. Your starter workbench is ready — head there to send your first message.",
  },
  {
    icon: <Bot />,
    title: "Routines",
    description:
      "A routine is a workflow an agent runs on your behalf — scheduled, triggered, or kicked off right from a workbench. A couple of starter routines are already running.",
  },
  {
    icon: <AtSign />,
    title: "@mention an agent",
    description:
      "Type @ in any workbench to bring an agent into the conversation — it reads the thread and replies inline, just like a teammate would.",
  },
] as const;

const ROUTINE_LABELS: Readonly<Record<string, string>> = {
  echo: "Echo routine",
  assistant: "Myra routine",
};

function routineLabel(assetName: string): string {
  return ROUTINE_LABELS[assetName] ?? assetName;
}

type WizardState =
  | { readonly phase: "provisioning" }
  | { readonly phase: "provisioning-error"; readonly message: string }
  | { readonly phase: "credential"; readonly error: string | null }
  | { readonly phase: "submitting" }
  | { readonly phase: "finishing-setup" }
  | {
      readonly phase: "connect-tools";
      readonly tenantId: string;
      readonly tenantSlug: string;
      readonly workflows: readonly string[];
    }
  | {
      readonly phase: "seeded";
      readonly tenantSlug: string;
      readonly workflows: readonly string[];
    }
  | { readonly phase: "guidance" };

/** A credential outcome lands on the optional "Connect your tools" phase
 * only when the response carried a tenant id (every current backend
 * does) — an older response missing it skips straight to the seeded
 * ending rather than rendering a step that can't fetch anything. */
function seededOrConnectTools(outcome: {
  readonly tenantId?: string;
  readonly tenantSlug: string;
  readonly workflows: readonly string[];
}): WizardState {
  if (outcome.tenantId !== undefined) {
    return {
      phase: "connect-tools",
      tenantId: outcome.tenantId,
      tenantSlug: outcome.tenantSlug,
      workflows: outcome.workflows,
    };
  }
  return {
    phase: "seeded",
    tenantSlug: outcome.tenantSlug,
    workflows: outcome.workflows,
  };
}

type ConnectToolsLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly credentials: readonly Credential[];
      readonly providers: readonly Provider[];
    };

/**
 * The optional "Connect your tools" step's card grid: fetches this
 * tenant's credentials/providers directly (the wizard has no other
 * reason to hold them) and renders `@corbits/settings-ui`'s
 * `ConnectorCardGrid` — the same component Settings · Connections
 * uses — filtered to connectors that actually feed a tool package.
 * Never gates: the advance button below always advances, whether or
 * not anything got connected here — its label just switches from "Skip
 * for now" to "Continue" once a connector actually connects, so it stops
 * reading as an escape hatch the moment there's something to continue with.
 */
export function ConnectToolsGrid({
  tenantId,
  onDone,
}: {
  readonly tenantId: string;
  readonly onDone: () => void;
}) {
  const [state, setState] = useState<ConnectToolsLoadState>({
    kind: "loading",
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [connectedThisSession, setConnectedThisSession] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([listCredentials(tenantId), listProviders(tenantId)])
      .then(([credentials, providers]) => {
        if (!cancelled) setState({ kind: "ready", credentials, providers });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, reloadKey]);

  return (
    <div className="onboarding-connect-tools">
      {state.kind === "loading" && (
        <div className="onboarding-connect-tools-loading" aria-hidden="true">
          <div className="onboarding-spinner" />
        </div>
      )}
      {state.kind === "error" && (
        <EmptyState
          icon={<CircleAlert />}
          title="Couldn't load your connections"
          description={state.message}
        />
      )}
      {state.kind === "ready" && (
        <div className="settings-connections-grid">
          <ConnectorCardGrid
            tenantId={tenantId}
            credentials={state.credentials}
            providers={state.providers}
            filter={(descriptor) => descriptor.feedsTools.length > 0}
            onReload={() => setReloadKey((value) => value + 1)}
            onConnected={() => setConnectedThisSession(true)}
          />
        </div>
      )}
      <Button variant="outline" onClick={onDone}>
        {connectedThisSession ? "Continue" : "Skip for now"}
      </Button>
    </div>
  );
}

function GuidanceCards() {
  return (
    <div className="card-grid">
      {GUIDANCE_CARDS.map((card) => (
        <Card key={card.title}>
          <CardHeader>
            {card.icon}
            <CardTitle>{card.title}</CardTitle>
            <CardDescription>{card.description}</CardDescription>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

/** "Connect your tools" is the only step the wizard lets you skip — see
 * ConnectToolsGrid's doc comment. */
const ONBOARDING_STEPS: readonly DialogStepperStep[] = [
  { label: "Add a credential" },
  { label: "Connect your tools", optional: true },
  { label: "Run your first routine" },
];

/** Which of the three questions a given wizard phase belongs to — the
 * progress rail's only job, decoupled from the phase's own render.
 * Provisioning happens automatically (there is no naming step to gate
 * it on), so it reads as part of the credential step's setup. */
function stepFor(phase: WizardState["phase"]): number {
  switch (phase) {
    case "provisioning":
    case "provisioning-error":
    case "credential":
    case "submitting":
    case "finishing-setup":
      return 1;
    case "connect-tools":
      return 2;
    case "seeded":
    case "guidance":
      return 3;
  }
}

/** One focused question per phase: the progress rail, a large title, an
 * optional subtitle, then the phase's own content. Keying the animated
 * wrapper on the title gives every phase change a fresh, tasteful entrance
 * — `prefers-reduced-motion` is respected by the `onboarding-phase`
 * animation itself (see app.css). */
function OnboardingPhase({
  phase,
  title,
  subtitle,
  children,
}: {
  readonly phase: WizardState["phase"];
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
}) {
  const step = stepFor(phase);
  return (
    <OnboardingLayout>
      <div className="onboarding-phase" key={title}>
        <DialogStepper step={step} steps={ONBOARDING_STEPS} />
        <h1 className="onboarding-title">{title}</h1>
        {subtitle !== undefined && (
          <p className="onboarding-subtitle">{subtitle}</p>
        )}
        <div className="onboarding-content">{children}</div>
      </div>
    </OnboardingLayout>
  );
}

function ProviderCardButton({
  provider,
  selected,
  disabled,
  onSelect,
}: {
  readonly provider: CredentialProviderCard;
  readonly selected: CredentialProvider;
  readonly disabled: boolean;
  readonly onSelect: (provider: CredentialProvider) => void;
}) {
  return (
    <Button
      type="button"
      role="radio"
      title={provider.description}
      aria-checked={provider.id === selected}
      variant={provider.id === selected ? "primary" : "outline"}
      disabled={disabled}
      onClick={() => onSelect(provider.id)}
    >
      <ProviderMark provider={provider.id} size="sm" />
      {provider.label}
    </Button>
  );
}

function ProviderPicker({
  selected,
  onSelect,
  disabled,
}: {
  readonly selected: CredentialProvider;
  readonly onSelect: (provider: CredentialProvider) => void;
  readonly disabled: boolean;
}) {
  // The six providers most people reach for lead the row; the rest stay
  // fully functional but tucked behind "More providers" so the primary
  // choice never has to compete with a wall of cards. A secondary pick
  // (e.g. returning to the flow with Groq already selected) opens the
  // expander automatically rather than hiding the active choice.
  const secondaryHasSelection = SECONDARY_CREDENTIAL_PROVIDERS.some(
    (provider) => provider.id === selected,
  );
  return (
    <div
      role="radiogroup"
      aria-label="Inference provider"
      className="onboarding-provider-picker"
    >
      {PRIMARY_CREDENTIAL_PROVIDERS.map((provider) => (
        <ProviderCardButton
          key={provider.id}
          provider={provider}
          selected={selected}
          disabled={disabled}
          onSelect={onSelect}
        />
      ))}
      <details
        className="onboarding-provider-more"
        open={secondaryHasSelection}
      >
        <summary className="onboarding-provider-more-trigger">
          More providers
        </summary>
        <div className="onboarding-provider-more-panel">
          {SECONDARY_CREDENTIAL_PROVIDERS.map((provider) => (
            <ProviderCardButton
              key={provider.id}
              provider={provider}
              selected={selected}
              disabled={disabled}
              onSelect={onSelect}
            />
          ))}
        </div>
      </details>
    </div>
  );
}

/** Where the wizard starts: at the top, unless the URL carries a connect
 * round-trip's outcome (OpenRouter or Hugging Face) — a fresh connect
 * lands on the finishing-setup phase (the OAuth callback only proved
 * and stored the key; this page's own follow-up call is what actually
 * deploys the default routines), and a failed round trip lands on the
 * credential step with the failure spelled out. Either way, the mount
 * effect below re-checks the account's real state before trusting a
 * connect outcome carried in the URL — see its own comment. */
function initialWizardState(): WizardState {
  if (typeof window === "undefined") return { phase: "provisioning" };
  const returned =
    readOpenRouterConnectReturn(window.location.search) ??
    readHuggingFaceConnectReturn(window.location.search);
  if (returned === null) return { phase: "provisioning" };
  if (returned.kind === "connected") return { phase: "finishing-setup" };
  return { phase: "credential", error: returned.message };
}

export function OnboardingPage({ user }: { readonly user: SessionUser }) {
  const navigate = useNavigate();
  const [state, setState] = useState<WizardState>(initialWizardState);
  const [provider, setProvider] = useState<CredentialProvider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  // True for a returning user whose workbench already exists but is
  // still missing a working credential (`existing-member` with
  // `seeded: false`) — the copy below tells them connecting one now
  // finishes setup, instead of the first-run pitch.
  const [resumingUnseeded, setResumingUnseeded] = useState(false);

  const runProvisioning = useCallback((name: string) => {
    setState({ phase: "provisioning" });
    void triggerFirstLoginProvisioning(name).then((result) => {
      if (result.kind === "error") {
        setState({ phase: "provisioning-error", message: result.message });
      } else if (result.kind === "existing-member" && result.seeded === true) {
        // Fully set up already (the common repeat-landing case now that
        // provisioning runs automatically every time, not just after an
        // explicit name submit): skip the credential step entirely.
        setState({ phase: "guidance" });
      } else if (result.kind === "existing-member") {
        // `seeded === false` is the bench_unseeded condition: this
        // account's own workbench exists but never got a working
        // credential (no operator key configured, and none connected
        // yet). `undefined` (membership on some other tenant) also lands
        // here rather than guidance — there is nothing to skip ahead to.
        const unseeded = result.seeded === false;
        setResumingUnseeded(unseeded);
        setState({ phase: "credential", error: null });
      } else if (result.kind === "provisioned" && result.seeded) {
        // A working credential already deployed and confirmed the
        // default workflow set against this brand-new bench — a
        // hub-owned key (the env-key auto-plant, CL-6101, or the older
        // ANTHROPIC_API_KEY path), the same "nothing left to prove"
        // case as a returning, fully-seeded existing member above.
        setResumingUnseeded(false);
        setState({ phase: "guidance" });
      } else if (result.kind === "provisioned") {
        setResumingUnseeded(false);
        setState({ phase: "credential", error: null });
      } else {
        // needs-onboarding after an explicit name should not happen — a
        // default name is always sent — so this reads as a soft error.
        setState({
          phase: "provisioning-error",
          message: "Setup couldn't create your workbench. Try again.",
        });
      }
    });
  }, []);

  // A connect round-trip's outcome is consumed into the initial wizard
  // state above; dropping it from the URL keeps a reload or a shared
  // link from replaying a stale ending.
  useEffect(() => {
    if (
      readOpenRouterConnectReturn(window.location.search) !== null ||
      readHuggingFaceConnectReturn(window.location.search) !== null
    ) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  // Two jobs, split by what landed the wizard here. A fresh connect
  // (`finishing-setup`) actually finishes the job the OAuth callback
  // deferred: `completeSetup` runs the workflow deploy the callback
  // never ran inline. Everything else — the ordinary first-run landing,
  // or a stale connect error from a duplicate callback this page never
  // saw resolved — provisions with a default name derived from the
  // account: there is no naming step to gate this on, so it must always
  // send a name (see `defaultWorkbenchName`). A returning member's
  // already-provisioned workbench is unaffected — the hub route only
  // creates one the first time an account has none.
  useEffect(() => {
    if (state.phase === "finishing-setup") {
      void completeSetup().then((outcome) => {
        if (outcome.kind === "seeded") {
          setState(seededOrConnectTools(outcome));
        } else if (outcome.kind === "unseeded") {
          setResumingUnseeded(true);
          setState({ phase: "credential", error: null });
        } else {
          setState({ phase: "credential", error: outcome.message });
        }
      });
      return;
    }
    runProvisioning(defaultWorkbenchName(user));
    // Mount-only: this reads `state.phase` exactly once, at the value
    // `initialWizardState` produced, to decide which of the two checks
    // above applies to this landing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmitCredential = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setState({ phase: "submitting" });
      void submitCredential(provider, apiKey).then((outcome) => {
        if (outcome.kind === "seeded") {
          setState(seededOrConnectTools(outcome));
        } else {
          setState({ phase: "credential", error: outcome.message });
        }
      });
    },
    [provider, apiKey],
  );

  if (state.phase === "provisioning") {
    return (
      <OnboardingPhase
        phase={state.phase}
        title="Setting up your workbench"
        subtitle="One moment."
      >
        <div className="onboarding-spinner" aria-hidden="true" />
      </OnboardingPhase>
    );
  }

  if (state.phase === "finishing-setup") {
    return (
      <OnboardingPhase
        phase={state.phase}
        title="Setting up your workbench…"
        subtitle="Your key checked out — starting your default routines now."
      >
        <div className="onboarding-spinner" aria-hidden="true" />
      </OnboardingPhase>
    );
  }

  if (state.phase === "provisioning-error") {
    return (
      <OnboardingPhase
        phase={state.phase}
        title="Couldn't set up your workbench"
      >
        <EmptyState
          icon={<CircleAlert />}
          title="Couldn't set up your workbench"
          description={state.message}
          action={
            <Button
              variant="outline"
              onClick={() => runProvisioning(defaultWorkbenchName(user))}
            >
              Try again
            </Button>
          }
        />
      </OnboardingPhase>
    );
  }

  if (state.phase === "guidance") {
    return (
      <OnboardingPhase
        phase={state.phase}
        title="Your workbench is ready"
        subtitle="We've set up your first workbench — a conversation with your personal agent — with the default workflows running. Here's what to expect."
      >
        <GuidanceCards />
        <Button asChild>
          <Link to="/">Meet Myra</Link>
        </Button>
      </OnboardingPhase>
    );
  }

  if (state.phase === "connect-tools") {
    return (
      <OnboardingPhase
        phase={state.phase}
        title="Connect your tools"
        subtitle="Connect Linear or Granola and your routines can read real work — meetings, issues, docs — instead of asking you to paste them. Optional, and you can always come back to this in Settings later."
      >
        <ConnectToolsGrid
          tenantId={state.tenantId}
          onDone={() =>
            setState({
              phase: "seeded",
              tenantSlug: state.tenantSlug,
              workflows: state.workflows,
            })
          }
        />
      </OnboardingPhase>
    );
  }

  if (state.phase === "seeded") {
    const checklist: ChecklistStep[] = state.workflows.map((assetName) => ({
      id: assetName,
      label: routineLabel(assetName),
      status: "done",
      detail: "confirmed running with your credential",
    }));
    return (
      <OnboardingPhase
        phase={state.phase}
        title="Your first routines are running"
        subtitle="Your key checked out, and every default routine on your workbench has already fired and answered."
      >
        <ProgressChecklist steps={checklist} label="Default routines" />
        <Button onClick={() => navigate("/")}>Meet Myra</Button>
      </OnboardingPhase>
    );
  }

  const submitting = state.phase === "submitting";
  const error = state.phase === "credential" ? state.error : null;
  const activeProvider = CREDENTIAL_PROVIDERS.find((p) => p.id === provider);

  return (
    <OnboardingPhase
      phase={state.phase}
      title={
        resumingUnseeded
          ? "Finish setting up your workbench"
          : "Add an inference credential"
      }
      subtitle={
        resumingUnseeded
          ? "Your workbench is ready, but it still needs a working inference credential before any agent or routine can run. Connect one below to finish setup."
          : "Your workbench needs an inference credential before any agent or routine can run. Connect OpenRouter in one click, or pick a provider and paste your own key — either way it's used only for this workbench."
      }
    >
      <section
        className="onboarding-connect-card"
        aria-label="Connect with OpenRouter"
      >
        <div>
          <h2>Connect with OpenRouter</h2>
          <p>
            The easiest path: one click, ~50 models, pay-as-you-go. Approve
            access on OpenRouter and your workbench comes back with a working
            key — nothing to copy.
          </p>
        </div>
        <Button asChild>
          <a href={OPENROUTER_CONNECT_START_PATH}>Connect with OpenRouter</a>
        </Button>
      </section>
      <section
        className="onboarding-connect-card"
        aria-label="Sign in with Hugging Face"
      >
        <div>
          <h2>Sign in with Hugging Face</h2>
          <p>
            Pay-as-you-go across Groq, Together, Fireworks &amp; more, billed to
            your HF account — approve access and your workbench comes back with
            a working connection.
          </p>
        </div>
        <Button asChild>
          <a href={HUGGINGFACE_CONNECT_START_PATH}>Sign in with Hugging Face</a>
        </Button>
      </section>
      <div className="onboarding-connect-divider" role="separator">
        or paste a provider API key
      </div>
      <form
        onSubmit={handleSubmitCredential}
        className="onboarding-credential-form"
      >
        <ProviderPicker
          selected={provider}
          onSelect={setProvider}
          disabled={submitting}
        />
        {activeProvider !== undefined && (
          <p className="onboarding-provider-description">
            {activeProvider.description}
          </p>
        )}
        <label htmlFor="onboarding-api-key">
          {activeProvider?.label} API key
        </label>
        <Input
          id="onboarding-api-key"
          type="text"
          placeholder={
            activeProvider?.keyHint
              ? `${activeProvider.keyHint}...`
              : "Paste your key"
          }
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          required
          disabled={submitting}
          aria-describedby="onboarding-api-key-help"
        />
        <p id="onboarding-api-key-help">
          <a
            href={activeProvider?.keyConsoleUrl}
            target="_blank"
            rel="noreferrer"
          >
            Get a key from the {activeProvider?.label} console
          </a>
          {activeProvider?.keyHint ? (
            <>
              {" "}
              — it starts with <code>{activeProvider.keyHint}</code>.
            </>
          ) : (
            "."
          )}
        </p>
        {error !== null && (
          <EmptyState
            icon={<KeyRound />}
            title="That key didn't work"
            description={error}
          />
        )}
        <Button type="submit" disabled={submitting || apiKey.length === 0}>
          {submitting
            ? "Testing your key…"
            : "Test key and run my first routine"}
        </Button>
      </form>
    </OnboardingPhase>
  );
}
