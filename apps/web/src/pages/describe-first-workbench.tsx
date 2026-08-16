// The fourth of onboarding's four steps (CL-6104), reached from `/` the
// moment a brand-new account's bench has zero workbenches — see
// `home-page.tsx`'s `HomeRoute`, which renders this in place of the
// auto land-hop for exactly that case. One field, one action: describe
// the job, and the same drafting machinery `CreateAgentPanel` uses
// (`draftAgentDefinition` → `createAgentDefinition`, CL-6074/CL-6086)
// turns that description into a drafted agent, deployed and opened —
// the same `launchAgentChat` hop an explicitly-defined new agent gets.
// The drafted system prompt itself carries the instruction that the
// agent's first reply greets the person and names what it can do (see
// `packages/task-planner/src/agent-definition-drafting.ts`), so landing
// in the fresh conversation is step four: the greeting arrives on its
// own, no extra wiring here.
//
// No name field, no template picker, no options beyond the one action —
// a name and a handle are derived from the description so the person
// never has to answer two questions to ask for one thing. Drafting
// fails closed, same as `CreateAgentPanel`: a failure here shows the
// real reason inline with a retry, never a dead spinner.

import { Button, EmptyState } from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

import { ApiQueryError } from "@corbits/api-query";

import { launchAgentChat } from "../agent-chat-launch";
import { createAgentDefinition, draftAgentDefinition } from "../agents-api";
import { slugify } from "./create-agent-panel";

const MAX_NAME_WORDS = 5;
const FALLBACK_NAME = "My Agent";

/** A short agent name derived from the description, so the describe
 * screen never has to ask for one separately. Falls back to a generic
 * name for a description too short or too punctuation-heavy to yield
 * anything nameable — `createAgentDefinition` still needs a non-empty
 * name and handle either way. */
export function deriveWorkbenchName(description: string): string {
  const words = description
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_NAME_WORDS);
  if (words.length === 0) return FALLBACK_NAME;
  const name = words.join(" ");
  return name.length > 60 ? `${name.slice(0, 60).trimEnd()}` : name;
}

type SubmitState =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | { readonly kind: "error"; readonly message: string };

export function DescribeFirstWorkbench({
  tenantId,
  navigate,
}: {
  readonly tenantId: string;
  readonly navigate: (to: string) => void;
}) {
  const [description, setDescription] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = description.trim();
    if (trimmed === "" || state.kind === "submitting") return;

    setState({ kind: "submitting" });
    const name = deriveWorkbenchName(trimmed);
    const handle = slugify(name) || "my-agent";
    try {
      const draft = await draftAgentDefinition(tenantId, {
        name,
        purpose: trimmed,
      });
      const created = await createAgentDefinition(tenantId, {
        name,
        handle,
        systemPrompt: draft.systemPrompt,
        description: draft.description ?? trimmed,
        ...(draft.modelPreference !== undefined
          ? { model: draft.modelPreference }
          : {}),
        ...(draft.skills !== undefined ? { skills: draft.skills } : {}),
      });
      await launchAgentChat(tenantId, created.id, navigate);
    } catch (cause) {
      setState({
        kind: "error",
        message:
          cause instanceof ApiQueryError
            ? cause.message
            : "Couldn't create your workbench. Try again.",
      });
      return;
    }
  }

  const submitting = state.kind === "submitting";

  return (
    // Inside the signed-in shell already — no brand split-panel here, just
    // the calm centered column. The full OnboardingLayout belongs to the
    // pre-shell wizard pages only.
    <div className="describe-first-workbench">
      <div className="onboarding-phase" key="describe-first-workbench">
        <h1 className="onboarding-title">What should your first agent do?</h1>
        <p className="onboarding-subtitle">
          Describe the job in a sentence — Myra drafts an agent built for it,
          and you land straight in the conversation.
        </p>
        <div className="onboarding-content">
          <form
            className="onboarding-describe-form"
            onSubmit={(e) => void submit(e)}
          >
            <label htmlFor="describe-first-workbench-input">
              What do you want to work on?
            </label>
            <textarea
              id="describe-first-workbench-input"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="A weekly digest of competitor moves, or someone to draft replies to support tickets…"
              disabled={submitting}
              required
              rows={4}
              autoFocus
            />
            {state.kind === "error" && (
              <EmptyState
                icon={<CircleAlert />}
                title="Couldn't create your workbench"
                description={state.message}
              />
            )}
            <Button
              type="submit"
              disabled={submitting || description.trim() === ""}
            >
              {submitting ? "Creating your workbench…" : "Create my workbench"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
