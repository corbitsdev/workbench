// The GTM template (CL-6349): the go-to-market workbench, ported from the
// OG gtm-workbench's four v1 workflows.
//
// The call backbone (granola-call discovering new calls, process-granola-call
// writing each one up) is what makes the workbench useful on day one, so it
// is the routine that runs on a clock without anyone asking. The web watch
// runs on its own weekly clock. The CRM agent and the collateral drafter are
// on-demand: both start from a specific thing a person points at.
import type { WorkbenchDefinition } from "../index";

export const GTM_TEMPLATE: WorkbenchDefinition = {
  id: "gtm",
  title: "Go to market",
  promise:
    "Your calls get written up, your CRM tasks get worked, and the web gets watched — you approve anything that leaves the room.",
  blocks: [
    { assetName: "granola-call", version: "0.0.1" },
    { assetName: "process-granola-call", version: "0.0.1" },
    { assetName: "attio-task-agent", version: "0.0.1" },
    { assetName: "exa-topic-watch", version: "0.0.1" },
    { assetName: "pain-point-collateral", version: "0.0.1" },
  ],
  // Attio and Exa are hard requirements: the CRM agent has nothing to
  // work without Attio, and the web watch has nothing to read without
  // Exa. Granola is what the call backbone runs on — the create flow
  // offers it up front, but a workbench with the CRM agent and the web
  // watch alone is still a real workbench, so it never blocks the create.
  plugins: { required: ["attio", "exa"], optional: ["granola"] },
  tools: [],
  webhookTriggers: [],
  routines: [
    {
      key: "call-discovery",
      blockAssetName: "granola-call",
      label: "Check for new calls",
      cron: "*/30 9-18 * * 1-5",
      why: "Notes are worth most right after the call, so this looks for new ones through the working day rather than once overnight.",
    },
    {
      key: "topic-watch",
      blockAssetName: "exa-topic-watch",
      label: "Watch the web",
      cron: "0 8 * * 1",
      why: "One digest at the start of the week, so a quiet week reads as quiet instead of as five empty runs.",
    },
  ],
  agents: [
    {
      handle: "crm",
      displayName: "CRM task agent",
      blockAssetName: "attio-task-agent",
      role: "Point it at a CRM task and it works the task — reading first, drafting second, and asking before it writes anything back.",
    },
    {
      handle: "collateral",
      displayName: "Pain-point collateral",
      blockAssetName: "pain-point-collateral",
      role: "Give it a call transcript and it drafts a piece aimed at the pain point the customer actually named.",
    },
  ],
  openInputs: [
    {
      key: "topic",
      label: "What should we watch?",
      placeholder: "AI coding agents for go-to-market",
      help: "One topic, as specific as you can make it. The weekly digest covers this and nothing else.",
      required: true,
      appliesToRoutine: "topic-watch",
    },
  ],
  // GTM is not offered by the picker yet, and both its instantiation
  // paths say so out loud rather than half-creating a workbench:
  // `instantiateWorkbenchTemplate` throws because its agents are lenses
  // over deployed workflow definitions with no agent-directory create
  // request, and the web `beginOnboarding` binding throws because
  // neither Attio nor Exa has an in-room onboarding card.
  onboardingSteps: [
    {
      kind: "connect-plugin",
      connectorId: "attio",
      title: "Connect Attio",
      why: "The CRM agent reads and works your tasks in Attio — without it there is nothing to work.",
    },
    {
      kind: "connect-plugin",
      connectorId: "exa",
      title: "Connect Exa",
      why: "The weekly web watch reads the open web through Exa.",
    },
    {
      kind: "connect-plugin",
      connectorId: "granola",
      title: "Connect Granola",
      why: "Connect it and every new call gets written up on its own; skip it and the rest of the workbench still works.",
    },
  ],
};
