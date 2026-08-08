// First-run, end to end: land here fresh with no usable inference
// credential, add one for real, and watch the default routines fire.
// The heavy lifting — proving the key with a real call, seeding the
// bench, deploying and confirming every default workflow — all happens
// server-side in `@workbench/onboarding`; this page is the guided
// wizard around it. A session that already has a seeded bench (an
// operator-configured seed key, or a returning member) skips straight
// to the orientation cards this screen always ended with.

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
  Section,
} from "@corbits/react-ui";
import type { ChecklistStep, WorkflowStep } from "@corbits/react-ui";
import {
  AtSign,
  Bot,
  CircleAlert,
  KeyRound,
  Library,
  MessageSquare,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";

import { Link, useNavigate } from "../navigation";
import { submitCredential, triggerFirstLoginProvisioning } from "../onboarding";

const GUIDANCE_CARDS = [
  {
    icon: <MessageSquare />,
    title: "Channels",
    description:
      "Conversations with your team and your agents live in channels, the same way threads do — a starter channel is ready for you below.",
  },
  {
    icon: <Bot />,
    title: "Routines",
    description:
      "A routine is a workflow an agent runs on your behalf — scheduled, triggered, or kicked off right from chat. Runs show up under Runs as they execute.",
  },
  {
    icon: <Library />,
    title: "Library",
    description:
      "Every workflow definition running anywhere in your benches is browsable in the Library, so you can see what a routine actually does before trusting it.",
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
  assistant: "Assistant routine",
};

function routineLabel(assetName: string): string {
  return ROUTINE_LABELS[assetName] ?? assetName;
}

type WizardState =
  | { readonly phase: "loading" }
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
  const credentialDone = phase === "seeded" || phase === "guidance";
  const credentialCurrent = phase === "credential" || phase === "submitting";
  return [
    {
      number: 1,
      label: "Add a credential",
      status: credentialDone
        ? "completed"
        : credentialCurrent
          ? "current"
          : "pending",
    },
    {
      number: 2,
      label: "Run your first routine",
      status:
        phase === "seeded"
          ? "completed"
          : credentialCurrent
            ? "pending"
            : "pending",
    },
  ];
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<WizardState>({ phase: "loading" });
  const [apiKey, setApiKey] = useState("");

  const runProvisioning = useCallback(() => {
    setState({ phase: "loading" });
    void triggerFirstLoginProvisioning().then((result) => {
      if (result.kind === "error") {
        setState({ phase: "provisioning-error", message: result.message });
      } else if (result.kind === "existing-member") {
        setState({ phase: "guidance" });
      } else if (result.seeded) {
        setState({ phase: "guidance" });
      } else {
        setState({ phase: "credential", error: null });
      }
    });
  }, []);
  useEffect(runProvisioning, [runProvisioning]);

  const handleSubmitCredential = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setState({ phase: "submitting" });
      void submitCredential(apiKey).then((outcome) => {
        if (outcome.kind === "seeded") {
          setState({
            phase: "seeded",
            tenantSlug: outcome.tenantSlug,
            workflows: outcome.workflows,
          });
        } else {
          setState({ phase: "credential", error: outcome.message });
        }
      });
    },
    [apiKey],
  );

  if (state.phase === "loading") {
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
            <Button variant="outline" onClick={runProvisioning}>
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
            <Link to="/chat">Go to your starter channel</Link>
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
          description="Your Anthropic key checked out, and every default routine on your bench has already fired and answered."
        >
          <HorizontalStepper steps={wizardSteps(state.phase)} />
          <ProgressChecklist steps={checklist} label="Default routines" />
          <Button onClick={() => navigate("/chat")}>
            Open your starter channel
          </Button>
        </Section>
      </PageShell>
    );
  }

  const submitting = state.phase === "submitting";
  const error = state.phase === "credential" ? state.error : null;

  return (
    <PageShell width="full" className="page-fill">
      <Section
        title="Add your Anthropic key"
        description="Your workbench needs an inference credential before any agent or routine can run. This one is yours — used only for this bench."
      >
        <HorizontalStepper steps={wizardSteps(state.phase)} />
        <form
          onSubmit={handleSubmitCredential}
          className="onboarding-credential-form"
        >
          <label htmlFor="onboarding-api-key">Anthropic API key</label>
          <Input
            id="onboarding-api-key"
            type="text"
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            required
            disabled={submitting}
            aria-describedby="onboarding-api-key-help"
          />
          <p id="onboarding-api-key-help">
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noreferrer"
            >
              Get a key from the Anthropic console
            </a>{" "}
            — it starts with <code>sk-ant-</code>.
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
