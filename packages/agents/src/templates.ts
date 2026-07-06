import type { CredentialRequirement, GrantRequirement } from "@intx/types";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import {
  PERSONAL_AGENT_DEPLOY_PROMPT,
  PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_NAME,
  PERSONAL_AGENT_MODEL_CONFIG,
  buildPersonalAgentGrantRequirements,
} from "./personal-agent/definition";
import {
  LOOP_DEPLOY_PROMPT,
  LOOP_CREDENTIAL_REQUIREMENTS,
  LOOP_GRANT_REQUIREMENTS,
  LOOP_DEPLOY_DESCRIPTOR,
  LOOP_MODEL_CONFIG,
} from "./loop/definition";
import {
  GRANOLA_DEPLOY_PROMPT,
  GRANOLA_CREDENTIAL_REQUIREMENTS,
  GRANOLA_GRANT_REQUIREMENTS,
  GRANOLA_CAPABILITIES,
  GRANOLA_MODEL_CONFIG,
} from "./granola/definition";
import {
  FIRECRAWL_DEPLOY_PROMPT,
  FIRECRAWL_CREDENTIAL_REQUIREMENTS,
  FIRECRAWL_GRANT_REQUIREMENTS,
  FIRECRAWL_CAPABILITIES,
  FIRECRAWL_MODEL_CONFIG,
} from "./firecrawl/definition";
import {
  WALTER_DEPLOY_PROMPT,
  WALTER_CREDENTIAL_REQUIREMENTS,
  WALTER_GRANT_REQUIREMENTS,
  WALTER_CAPABILITIES,
  WALTER_MODEL_CONFIG,
} from "./walter/definition";
import {
  HAMMY_DEPLOY_PROMPT,
  HAMMY_CREDENTIAL_REQUIREMENTS,
  HAMMY_GRANT_REQUIREMENTS,
  HAMMY_CAPABILITIES,
  HAMMY_MODEL_CONFIG,
} from "./hammy-the-humanizer/definition";
import {
  LINCOLN_DEPLOY_PROMPT,
  LINCOLN_CREDENTIAL_REQUIREMENTS,
  LINCOLN_GRANT_REQUIREMENTS,
  LINCOLN_CAPABILITIES,
  LINCOLN_MODEL_CONFIG,
} from "./lincoln/definition";
import {
  FREDDIE_DEPLOY_PROMPT,
  FREDDIE_CREDENTIAL_REQUIREMENTS,
  FREDDIE_GRANT_REQUIREMENTS,
  FREDDIE_CAPABILITIES,
  FREDDIE_MODEL_CONFIG,
} from "./freddie/definition";
import {
  FANNIE_DEPLOY_PROMPT,
  FANNIE_CREDENTIAL_REQUIREMENTS,
  FANNIE_GRANT_REQUIREMENTS,
  FANNIE_CAPABILITIES,
  FANNIE_MODEL_CONFIG,
} from "./fannie/definition";
import {
  FILE_PARSER_NAME,
  FILE_PARSER_SYSTEM_PROMPT,
  FILE_PARSER_CREDENTIAL_REQUIREMENTS,
  FILE_PARSER_GRANT_REQUIREMENTS,
  FILE_PARSER_MODEL_CONFIG,
} from "./file-parser/definition";

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

/**
 * Static grant requirements for Myra. Derived from
 * `buildPersonalAgentGrantRequirements` but with the dynamic per-workbench
 * `tenant:<id>:deliver` entry dropped — that grant depends on the launch-time
 * workbench tenant id and is computed at instance launch, not baked into the
 * seeded definition (CL-1530 locked design decision 2).
 */
const MYRA_STATIC_GRANT_REQUIREMENTS: GrantRequirementType[] =
  buildPersonalAgentGrantRequirements("").filter(
    (g) => !g.resource.startsWith("tenant:"),
  );

/**
 * A normalized agent template: the static, tenant-agnostic shape of a seedable
 * agent definition. `key` is a stable template identifier; `name` is the
 * display/agent name used as the per-tenant idempotency key when seeding.
 *
 * `grantRequirements` holds ONLY static entries — dynamic per-workbench grants
 * (e.g. `tenant:<id>:deliver`) are computed at instance launch, never seeded.
 *
 * `deployable` — when false, the template is seeded as an org definition but
 * not shown in the user-facing agent catalog. Defaults to true.
 */
export interface AgentTemplate {
  key: string;
  name: string;
  description: string;
  systemPrompt: string;
  credentialRequirements: CredentialRequirementType[];
  grantRequirements: GrantRequirementType[];
  capabilities: { tools: string[] };
  modelConfig?: Record<string, unknown>;
  deployable?: boolean;
  kind?: "personal";
  /**
   * Native tool packages this agent pins. Persisted to the agent DB row at
   * seed time and read back via `parseAgentRow(row).toolPackages` at launch.
   */
  toolPackages?: ToolPackagePin[];
}

/**
 * Registry of every agent template seeded as a first-class Interchange agent
 * definition in the global org tenant at hub boot (CL-1530). Reuses the existing
 * per-agent prompt / credential / grant / capability constants — no duplication.
 *
 * Base tool sources:
 *   - Myra:   PERSONAL_AGENT_BASE_TOOLS (empty today; single source of truth)
 *   - Loop:   LOOP_DEPLOY_DESCRIPTOR.defaultTools
 *   - Oat:    GRANOLA_CAPABILITIES.tools
 *   - Freddy: FIRECRAWL_CAPABILITIES.tools (Firecrawl agent)
 *   - Walter: WALTER_CAPABILITIES.tools
 *   - Hammy:  HAMMY_CAPABILITIES.tools
 */
// Freddie and Fannie share the same research + artifact tool set.
const FABLE_TOOL_PACKAGES: ToolPackagePin[] = [
  { name: "@workbench/tools-firecrawl", version: "^0.1.0" },
  { name: "@workbench/tools-hackernews", version: "^0.1.0" },
  { name: "@workbench/tools-github", version: "^0.1.0" },
  { name: "@workbench/tools-bluesky", version: "^0.1.0" },
  { name: "@workbench/tools-scrapecreators", version: "^0.1.0" },
  { name: "@workbench/tools-artifact", version: "^0.1.0" },
];

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    key: "myra",
    name: PERSONAL_AGENT_NAME,
    description:
      "Your personal AI assistant — always on, context-aware, and ready to help.",
    systemPrompt: PERSONAL_AGENT_DEPLOY_PROMPT,
    credentialRequirements: PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
    grantRequirements: MYRA_STATIC_GRANT_REQUIREMENTS,
    capabilities: { tools: [...PERSONAL_AGENT_BASE_TOOLS] },
    modelConfig: PERSONAL_AGENT_MODEL_CONFIG,
    kind: "personal",
    toolPackages: [
      { name: "@workbench/tools-exa", version: "^0.1.0" },
      { name: "@workbench/tools-linear", version: "^0.1.0" },
      { name: "@workbench/tools-attio", version: "^0.1.0" },
      { name: "@workbench/tools-granola", version: "^0.1.0" },
      { name: "@workbench/tools-artifact", version: "^0.1.0" },
      { name: "@workbench/tools-fileparser", version: "^0.1.0" },
      { name: "@workbench/tools-vercel", version: "^0.1.0" },
      { name: "@workbench/tools-agents", version: "^0.1.0" },
      { name: "@workbench/tools-skills", version: "^0.1.0" },
      { name: "@workbench/tools-workflows", version: "^0.1.0" },
    ],
  },
  {
    key: "oat",
    name: "Oat",
    description:
      "Pulls meeting notes from Granola and surfaces key signals for your pipeline.",
    systemPrompt: GRANOLA_DEPLOY_PROMPT,
    credentialRequirements: GRANOLA_CREDENTIAL_REQUIREMENTS,
    grantRequirements: GRANOLA_GRANT_REQUIREMENTS,
    capabilities: { tools: [...GRANOLA_CAPABILITIES.tools] },
    modelConfig: GRANOLA_MODEL_CONFIG,
    toolPackages: [{ name: "@workbench/tools-granola", version: "^0.1.0" }],
  },
  {
    key: "loop",
    name: "Loop",
    description: "Runs scheduled background tasks on a configurable interval.",
    systemPrompt: LOOP_DEPLOY_PROMPT,
    credentialRequirements: LOOP_CREDENTIAL_REQUIREMENTS,
    grantRequirements: LOOP_GRANT_REQUIREMENTS,
    capabilities: { tools: [...LOOP_DEPLOY_DESCRIPTOR.defaultTools] },
    modelConfig: LOOP_MODEL_CONFIG,
    deployable: false,
  },
  {
    key: "freddie",
    name: "Freddie",
    description:
      "Fable-style Opus agent with broad research and local artifact-writing tools, excluding outbound mail send.",
    systemPrompt: FREDDIE_DEPLOY_PROMPT,
    credentialRequirements: FREDDIE_CREDENTIAL_REQUIREMENTS,
    grantRequirements: FREDDIE_GRANT_REQUIREMENTS,
    capabilities: { tools: [...FREDDIE_CAPABILITIES.tools] },
    modelConfig: FREDDIE_MODEL_CONFIG,
    toolPackages: FABLE_TOOL_PACKAGES,
  },
  {
    key: "fannie",
    name: "Fannie",
    description:
      "Fable-style Sonnet agent with broad research and local artifact-writing tools, excluding outbound mail send.",
    systemPrompt: FANNIE_DEPLOY_PROMPT,
    credentialRequirements: FANNIE_CREDENTIAL_REQUIREMENTS,
    grantRequirements: FANNIE_GRANT_REQUIREMENTS,
    capabilities: { tools: [...FANNIE_CAPABILITIES.tools] },
    modelConfig: FANNIE_MODEL_CONFIG,
    toolPackages: FABLE_TOOL_PACKAGES,
  },
  {
    key: "file-parser",
    name: FILE_PARSER_NAME,
    description:
      "Model-agnostic document understanding — reads PDFs, documents, and images and returns their content as text. Invoked internally via the parse_file tool; not a chat agent.",
    systemPrompt: FILE_PARSER_SYSTEM_PROMPT,
    credentialRequirements: FILE_PARSER_CREDENTIAL_REQUIREMENTS,
    grantRequirements: FILE_PARSER_GRANT_REQUIREMENTS,
    capabilities: { tools: [] },
    modelConfig: FILE_PARSER_MODEL_CONFIG,
    deployable: false,
  },
  {
    key: "freddy",
    name: "Freddy",
    description:
      "Web research agent — crawls and extracts structured data from any URL.",
    systemPrompt: FIRECRAWL_DEPLOY_PROMPT,
    credentialRequirements: FIRECRAWL_CREDENTIAL_REQUIREMENTS,
    grantRequirements: FIRECRAWL_GRANT_REQUIREMENTS,
    capabilities: { tools: [...FIRECRAWL_CAPABILITIES.tools] },
    modelConfig: FIRECRAWL_MODEL_CONFIG,
    toolPackages: [{ name: "@workbench/tools-firecrawl", version: "^0.1.0" }],
  },
  {
    key: "walter",
    name: "Walter",
    description:
      "Content writer — turns briefs and research into polished GTM collateral.",
    systemPrompt: WALTER_DEPLOY_PROMPT,
    credentialRequirements: WALTER_CREDENTIAL_REQUIREMENTS,
    grantRequirements: WALTER_GRANT_REQUIREMENTS,
    capabilities: { tools: [...WALTER_CAPABILITIES.tools] },
    modelConfig: WALTER_MODEL_CONFIG,
    toolPackages: [{ name: "@workbench/tools-artifact", version: "^0.1.0" }],
  },
  {
    key: "hammy",
    name: "Hammy",
    description:
      "Humanizer — rewrites AI-sounding content to read as human-authored, or scores how human content already reads.",
    systemPrompt: HAMMY_DEPLOY_PROMPT,
    credentialRequirements: HAMMY_CREDENTIAL_REQUIREMENTS,
    grantRequirements: HAMMY_GRANT_REQUIREMENTS,
    capabilities: { tools: [...HAMMY_CAPABILITIES.tools] },
    modelConfig: HAMMY_MODEL_CONFIG,
    toolPackages: [{ name: "@workbench/tools-artifact", version: "^0.1.0" }],
  },
  {
    key: "lincoln",
    name: "Lincoln",
    description:
      "LinkedIn writer — drafts substantive, paste-ready posts grounded in field observations and call insights.",
    systemPrompt: LINCOLN_DEPLOY_PROMPT,
    credentialRequirements: LINCOLN_CREDENTIAL_REQUIREMENTS,
    grantRequirements: LINCOLN_GRANT_REQUIREMENTS,
    capabilities: { tools: [...LINCOLN_CAPABILITIES.tools] },
    modelConfig: LINCOLN_MODEL_CONFIG,
    toolPackages: [
      { name: "@workbench/tools-firecrawl", version: "^0.1.0" },
      { name: "@workbench/tools-artifact", version: "^0.1.0" },
    ],
  },
];

/**
 * Whether a live agent instance with this display name is a user-facing chat
 * agent that may be slept when idle and cleanly relaunched on the next
 * interaction (CL-2790, the idle-session reaper).
 *
 * A name is reapable only when it matches a known template whose `kind` is
 * `"personal"` — i.e. the per-member personal agent (Myra). CL-2790: the
 * personal agent is the ONLY agent with a proven on-demand wake — a member's
 * next visit hits `POST /v1/me`, which relaunches exactly the personal-agent
 * instance (`relaunchInstanceIfNeeded` on the resolved `paInstanceId`). Shared
 * / sub-agents (Oat, Walter, …) have no wake trigger on their next message: the
 * mail route only checks instance `status === "running"` and a non-null
 * `sessionId` (both still true after sleep) and never re-launches, so a slept
 * shared agent 502s on its next (often agent-to-agent) message with no
 * self-heal. So they are NOT reapable until a shared-agent wake path exists.
 * `deployable` means "catalog-visible", NOT "safe to sleep" — do not use it as
 * the discriminator. An unrecognized name (no template) is NOT reapable: the
 * reaper only ever sleeps an agent it positively identifies as wakeable.
 */
export function isReapableChatAgent(agentName: string): boolean {
  const template = AGENT_TEMPLATES.find((t) => t.name === agentName);
  return template !== undefined && template.kind === "personal";
}
