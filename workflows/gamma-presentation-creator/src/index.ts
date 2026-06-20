import { defineAgent } from "@intx/agent";
import { awaitSignal, defineWorkflow, step } from "@intx/workflow";
import {
  canonicalizeToolNames,
  deterministicToolStep,
  LLM_CREDENTIAL_NAME,
  LLM_DEFAULT_MODEL,
} from "@workbench/agents";

const generateAgent = defineAgent({
  id: "presentation-generate",
  description: "Drafts presentation content from the resolved source.",
  systemPrompt:
    "You are a presentation drafting agent. Generate the deck content from the provided source, audience, tone, and goal.",
  tools: [],
  capabilities: canonicalizeToolNames(["artifact_create", "write_artifact"]),
  inference: {
    sources: [{ provider: "openai-compatible", model: LLM_DEFAULT_MODEL }],
  },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

// Render stays an agent, not a deterministicToolStep: gamma_create_from_template
// requires { gammaId, prompt }, where `prompt` must be derived from the generate
// agent's free-text output. The selector DSL has no rename/templating selector
// (ProjectSelector selects existing field names; it cannot map
// steps.generate.output.reply -> a field named `prompt`), so the tool's args
// cannot be assembled from upstream output deterministically. The agent bridges
// that reshape. See CL-2202 notes: a templating/reshaping selector would let
// this become deterministic.
const renderAgent = defineAgent({
  id: "presentation-render",
  description: "Renders the approved deck into a branded Gamma presentation.",
  systemPrompt:
    "You are a Gamma rendering agent. Call gamma_create_from_template with the gammaId from the brief and a prompt built from the approved deck content.",
  tools: [],
  capabilities: canonicalizeToolNames(["gamma_create_from_template"]),
  inference: {
    sources: [{ provider: "openai-compatible", model: LLM_DEFAULT_MODEL }],
  },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

export const label = "Gamma Presentation Creator";
export const description =
  "Generate a polished Gamma presentation from a topic, audience, and key points.";
export const kind = "gamma-presentation-creator";

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    "list-templates": deterministicToolStep({
      id: "presentation-list-templates",
      tool: "gamma_list_templates",
    }),
    template: awaitSignal({ name: "template", after: ["list-templates"] }),
    "list-notes": deterministicToolStep({
      id: "presentation-list-notes",
      tool: "granola_list_notes",
      after: ["template"],
    }),
    "source-selection": awaitSignal({
      name: "source-selection",
      after: ["list-notes"],
    }),
    source: deterministicToolStep({
      id: "presentation-source",
      tool: "granola_get_note",
      input: { from: "steps.source-selection.output" },
      after: ["source-selection"],
    }),
    generate: step({
      agent: generateAgent,
      after: ["source"],
      input: {
        merge: [
          { from: "steps.template.output" },
          { from: "steps.source.output" },
        ],
      },
    }),
    review: awaitSignal({ name: "review-approval", after: ["generate"] }),
    render: step({
      agent: renderAgent,
      after: ["review"],
      input: {
        merge: [
          { from: "steps.template.output" },
          { from: "steps.generate.output" },
        ],
      },
    }),
  },
});
