// The fourth of onboarding's four steps (CL-6104), reached from `/` the
// moment a brand-new account's bench has zero workbenches — see
// `home-page.tsx`'s `HomeRoute`, which renders this in place of the
// auto land-hop for exactly that case. One prompt box, no other chrome
// (CL-6124): the owner's reference for this screen is a chat, not a form,
// so it reuses `FirstRunComposer` — the same drafting machinery
// `CreateAgentPanel` uses (`draftAgentDefinition` → `createAgentDefinition`,
// CL-6074/CL-6086) turns the typed message into a drafted agent, deployed
// and opened — the same `launchAgentChat` hop an explicitly-defined new
// agent gets. The drafted system prompt itself carries the instruction
// that the agent's first reply greets the person and names what it can do
// (see `packages/task-planner/src/agent-definition-drafting.ts`), so
// landing in the fresh conversation is step four: the greeting arrives on
// its own, no extra wiring here.
//
// No name field, no template picker — a name and a handle are derived
// from the message so the person never has to answer two questions to ask
// for one thing. Drafting fails closed, same as `CreateAgentPanel`: a
// failure here shows the real reason inline with the message preserved
// for a straight retry, never a dead spinner.

import { useState } from "react";

import { ApiQueryError } from "@corbits/api-query";
import { FirstRunComposer } from "@corbits/chat-ui";

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
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  async function handleSend(text: string): Promise<boolean> {
    if (state.kind === "submitting") return false;
    setState({ kind: "submitting" });
    const name = deriveWorkbenchName(text);
    const handle = slugify(name) || "my-agent";
    try {
      const draft = await draftAgentDefinition(tenantId, {
        name,
        purpose: text,
      });
      const created = await createAgentDefinition(tenantId, {
        name,
        handle,
        systemPrompt: draft.systemPrompt,
        description: draft.description ?? text,
        ...(draft.modelPreference !== undefined
          ? { model: draft.modelPreference }
          : {}),
        ...(draft.skills !== undefined ? { skills: draft.skills } : {}),
      });
      await launchAgentChat(tenantId, created.id, navigate);
      return true;
    } catch (cause) {
      setState({
        kind: "error",
        message:
          cause instanceof ApiQueryError
            ? `Couldn't create your workbench: ${cause.message}`
            : "Couldn't create your workbench. Try again.",
      });
      return false;
    }
  }

  return (
    // Inside the signed-in shell already — no brand split-panel here, just
    // the calm centered prompt box. The full OnboardingLayout belongs to
    // the pre-shell wizard pages only.
    <div className="describe-first-workbench">
      <FirstRunComposer
        placeholder="Message New Workbench…"
        sending={state.kind === "submitting"}
        error={state.kind === "error" ? state.message : null}
        onSend={handleSend}
      />
    </div>
  );
}
