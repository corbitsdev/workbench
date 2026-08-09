// First-run wizard in three steps: name your workbench, add an
// inference credential, then get oriented. The heavy lifting — proving
// the key with a real call, seeding the bench, deploying and confirming
// every default workflow — happens server-side in `@workbench/onboarding`;
// this page is the guided shell around it. The credential step is always
// part of the flow: when the server already has a usable seed (an
// operator-configured key, or a returning member) it renders
// pre-satisfied with a skip option rather than branching into a
// different tree that hides the step entirely.

import {
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  HorizontalStepper,
  Input,
  PageShell,
  ProgressChecklist,
  ProviderMark,
  Section,
} from "@corbits/react-ui";
import type { ChecklistStep, WorkflowStep } from "@corbits/react-ui";
import {
  AtSign,
  Bot,
  CircleAlert,
  CircleCheck,
  KeyRound,
  MessageSquare,
} from "lucide-react";
import { useCallback, useState } from "react";
import type { FormEvent } from "react";

import { Link, useNavigate } from "../navigation";
import {
  CREDENTIAL_PROVIDERS,
  submitCredential,
  triggerFirstLoginProvisioning,
} from "../onboarding";
import type { CredentialProvider } from "../onboarding";

const GUIDANCE_CARDS = [
  {
    icon: <MessageSquare />,
    title: "Channels",
    description:
      "Conversations with your team and your agents live in channels. Your starter channel is ready — head there to send your first message.",
  },
  {
    icon: <Bot />,
    title: "Routines",
    description:
      "A routine is a workflow an agent runs on your behalf — scheduled, triggered, or kicked off right from a channel. Your bench ships with a couple of starter routines already running.",
  },
  {
    icon: <AtSign />,
    title: "@mention an agent",
    description:
      "Type @ in any channel to bring an agent into the conversation — it reads the thread and replies inline, just like a teammate would.",
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
  | { readonly phase: "naming" }
  | { readonly phase: "provisioning" }
  | { readonly phase: "provisioning-error"; readonly message: string }
  | { readonly phase: "credential"; readonly error: string | null }
  | { readonly phase: "submitting" }
  | {
      readonly phase: "seeded";
      readonly tenantSlug: string;
      readonly workflows: readonly string[];
    }
  | { readonly phase: "guidance" };

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

function wizardSteps(phase: WizardState["phase"]): WorkflowStep[] {
  const nameDone = phase !== "naming";
  const credentialDone = phase === "seeded" || phase === "guidance";
  const credentialCurrent =
    phase === "credential" ||
    phase === "submitting" ||
    phase === "provisioning";
  return [
    {
      number: 1,
      label: "Name your workbench",
      status: nameDone ? "completed" : "current",
    },
    {
      number: 2,
      label: "Add a credential",
      status: credentialDone
        ? "completed"
        : credentialCurrent
          ? "current"
          : "pending",
    },
    {
      number: 3,
      label: "Run your first routine",
      status:
        phase === "seeded"
          ? "completed"
          : phase === "guidance"
            ? "completed"
            : "pending",
    },
  ];
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
  return (
    <div
      role="radiogroup"
      aria-label="Inference provider"
      className="onboarding-provider-picker"
    >
      {CREDENTIAL_PROVIDERS.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          role="radio"
          aria-checked={provider.id === selected}
          variant={provider.id === selected ? "primary" : "outline"}
          disabled={disabled}
          onClick={() => onSelect(provider.id)}
        >
          <ProviderMark provider={provider.id} size="sm" />
          {provider.label}
        </Button>
      ))}
    </div>
  );
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<WizardState>({ phase: "naming" });
  const [workbenchName, setWorkbenchName] = useState("");
  const [provider, setProvider] = useState<CredentialProvider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  // Whether the server already had a usable seed when we provisioned.
  // Kept out of WizardState so a failed own-key submit doesn't wipe the
  // skip option — the credential step stays in place either way.
  const [preSatisfied, setPreSatisfied] = useState(false);
  const [skipReason, setSkipReason] = useState<string | null>(null);

  const runProvisioning = useCallback((name: string) => {
    setState({ phase: "provisioning" });
    void triggerFirstLoginProvisioning(name).then((result) => {
      if (result.kind === "error") {
        setState({ phase: "provisioning-error", message: result.message });
      } else if (result.kind === "existing-member") {
        setPreSatisfied(true);
        setSkipReason(null);
        setState({ phase: "credential", error: null });
      } else if (result.kind === "provisioned" && result.seeded) {
        setPreSatisfied(true);
        setSkipReason(result.seedSkipReason ?? null);
        setState({ phase: "credential", error: null });
      } else if (result.kind === "provisioned") {
        setPreSatisfied(false);
        setSkipReason(null);
        setState({ phase: "credential", error: null });
      } else {
        // needs-onboarding after an explicit name should not happen; treat
        // as a soft error so the user can retry naming.
        setState({
          phase: "provisioning-error",
          message:
            "The hub did not create your workbench. Try a different name.",
        });
      }
    });
  }, []);

  const handleNameSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      runProvisioning(workbenchName);
    },
    [runProvisioning, workbenchName],
  );

  const handleSubmitCredential = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setState({ phase: "submitting" });
      void submitCredential(provider, apiKey).then((outcome) => {
        if (outcome.kind === "seeded") {
          setState({
            phase: "seeded",
            tenantSlug: outcome.tenantSlug,
            workflows: outcome.workflows,
          });
        } else {
          // preSatisfied is intentionally preserved: a bad own-key
          // submit must not remove the skip path the server seed gave.
          setState({ phase: "credential", error: outcome.message });
        }
      });
    },
    [provider, apiKey],
  );

  if (state.phase === "naming") {
    return (
      <PageShell width="full" className="page-fill">
        <Section
          title="Create your workbench"
          description="Give your workbench a name. This labels your personal bench across the app — you can change it later."
        >
          <HorizontalStepper steps={wizardSteps(state.phase)} />
          <form onSubmit={handleNameSubmit} className="onboarding-name-form">
            <label htmlFor="onboarding-workbench-name">Workbench name</label>
            <Input
              id="onboarding-workbench-name"
              type="text"
              placeholder="e.g. Ada's bench"
              value={workbenchName}
              onChange={(event) => setWorkbenchName(event.target.value)}
              required
              aria-describedby="onboarding-workbench-name-help"
              autoFocus
            />
            <p id="onboarding-workbench-name-help">
              Used as the display name for your bench.
            </p>
            <Button type="submit" disabled={workbenchName.trim().length === 0}>
              Continue
            </Button>
          </form>
        </Section>
      </PageShell>
    );
  }

  if (state.phase === "provisioning") {
    return (
      <PageShell width="full" className="page-fill">
        <Section title="Setting up your workbench" description="One moment.">
          <div />
        </Section>
      </PageShell>
    );
  }

  if (state.phase === "provisioning-error") {
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<CircleAlert />}
          title="Couldn't set up your workbench"
          description={state.message}
          action={
            <Button
              variant="outline"
              onClick={() => runProvisioning(workbenchName)}
            >
              Try again
            </Button>
          }
        />
      </PageShell>
    );
  }

  if (state.phase === "guidance") {
    return (
      <PageShell width="full" className="page-fill">
        <Section
          title="Your workbench is ready"
          description="We've set up a personal bench for you with a starter channel and the default workflows deployed. Here's what to expect."
        >
          <GuidanceCards />
          <Button asChild>
            <Link to="/">Meet Myra</Link>
          </Button>
        </Section>
      </PageShell>
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
      <PageShell width="full" className="page-fill">
        <Section
          title="Your first routines are running"
          description="Your key checked out, and every default routine on your bench has already fired and answered."
        >
          <HorizontalStepper steps={wizardSteps(state.phase)} />
          <ProgressChecklist steps={checklist} label="Default routines" />
          <Button onClick={() => navigate("/")}>
            Meet Myra
          </Button>
        </Section>
      </PageShell>
    );
  }

  const submitting = state.phase === "submitting";
  const error = state.phase === "credential" ? state.error : null;
  const activeProvider = CREDENTIAL_PROVIDERS.find((p) => p.id === provider);

  return (
    <PageShell width="full" className="page-fill">
      <Section
        title="Add an inference credential"
        description="Your workbench needs an inference credential before any agent or routine can run. Pick a provider and paste your own key — it's used only for this bench."
      >
        <HorizontalStepper steps={wizardSteps(state.phase)} />
        {preSatisfied && (
          <EmptyState
            icon={<CircleCheck />}
            title="A working key is already in place"
            description={
              skipReason ??
              "An operator-configured credential is set, so agents and routines can run right away. Add your own key below to use it instead, or skip ahead to your channel."
            }
            action={
              <Button
                variant="outline"
                onClick={() => setState({ phase: "guidance" })}
              >
                Skip — use the default key
              </Button>
            }
          />
        )}
        <form
          onSubmit={handleSubmitCredential}
          className="onboarding-credential-form"
        >
          <ProviderPicker
            selected={provider}
            onSelect={setProvider}
            disabled={submitting}
          />
          <label htmlFor="onboarding-api-key">
            {activeProvider?.label} API key
          </label>
          <Input
            id="onboarding-api-key"
            type="text"
            placeholder={`${activeProvider?.keyHint}...`}
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
            </a>{" "}
            — it starts with <code>{activeProvider?.keyHint}</code>.
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
      </Section>
    </PageShell>
  );
}
