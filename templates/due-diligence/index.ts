// The due-diligence template (CL-6499): Scout for the web/firm-memory
// research and Myra to talk through what it found. Scout is a
// standalone chat agent, not a lens over a block workflow — it has no
// cron, no webhook, nothing to schedule — so it carries no
// `blockAssetName` and this template's `blocks` list stays empty.
// Exa (Scout's web-research tool) resolves through the keyless MCP
// preset, so nothing here blocks the create on a connection.
import type { WorkbenchDefinition } from "../index";
import {
  SCOUT_AGENT_HANDLE,
  SCOUT_AGENT_DISPLAY_NAME,
  SCOUT_AGENT_DESCRIPTION,
  SCOUT_TOOL_PACKAGE_PINS,
} from "@corbits/scout-agent/definition";

export const DUE_DILIGENCE_TEMPLATE: WorkbenchDefinition = {
  id: "due-diligence",
  title: "Due Diligence",
  promise:
    "Scout checks a company, deal, or vendor against the web and what your team already knows, and saves what it finds so you can pick it up later.",
  blocks: [],
  plugins: { required: [], optional: ["exa"] },
  tools: SCOUT_TOOL_PACKAGE_PINS.map((pin) => pin.name),
  routines: [],
  webhookTriggers: [],
  agents: [
    {
      handle: "myra",
      displayName: "Myra",
      role: "Talks through what Scout found and helps you decide what to do with it.",
    },
    {
      handle: SCOUT_AGENT_HANDLE,
      displayName: SCOUT_AGENT_DISPLAY_NAME,
      role: SCOUT_AGENT_DESCRIPTION,
    },
  ],
  openInputs: [],
  onboardingSteps: [],
};
