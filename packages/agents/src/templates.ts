import type { CredentialRequirement, GrantRequirement } from '@intx/types';
import {
  PERSONAL_AGENT_DEPLOY_PROMPT,
  PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_NAME,
  buildPersonalAgentGrantRequirements,
} from './personal-agent/definition';
import {
  LOOP_DEPLOY_PROMPT,
  LOOP_CREDENTIAL_REQUIREMENTS,
  LOOP_GRANT_REQUIREMENTS,
  LOOP_DEPLOY_DESCRIPTOR,
} from './loop/definition';
import {
  GRANOLA_DEPLOY_PROMPT,
  GRANOLA_CREDENTIAL_REQUIREMENTS,
  GRANOLA_GRANT_REQUIREMENTS,
  GRANOLA_CAPABILITIES,
} from './granola/definition';
import {
  FIRECRAWL_DEPLOY_PROMPT,
  FIRECRAWL_CREDENTIAL_REQUIREMENTS,
  FIRECRAWL_GRANT_REQUIREMENTS,
  FIRECRAWL_CAPABILITIES,
} from './firecrawl/definition';
import {
  WALTER_DEPLOY_PROMPT,
  WALTER_CREDENTIAL_REQUIREMENTS,
  WALTER_GRANT_REQUIREMENTS,
  WALTER_CAPABILITIES,
} from './walter/definition';
import {
  HAMMY_DEPLOY_PROMPT,
  HAMMY_CREDENTIAL_REQUIREMENTS,
  HAMMY_GRANT_REQUIREMENTS,
  HAMMY_CAPABILITIES,
} from './hammy-the-humanizer/definition';
import {
  LINCOLN_DEPLOY_PROMPT,
  LINCOLN_CREDENTIAL_REQUIREMENTS,
  LINCOLN_GRANT_REQUIREMENTS,
  LINCOLN_CAPABILITIES,
} from './lincoln/definition';
import {
  BOBBY_DEPLOY_PROMPT,
  BOBBY_CREDENTIAL_REQUIREMENTS,
  BOBBY_GRANT_REQUIREMENTS,
  BOBBY_CAPABILITIES,
} from './bobby/definition';
import {
  GERALT_DEPLOY_PROMPT,
  GERALT_CREDENTIAL_REQUIREMENTS,
  GERALT_GRANT_REQUIREMENTS,
  GERALT_TOOL_NAMES,
} from './geralt/definition';
import {
  LARRY_DEPLOY_PROMPT,
  LARRY_CREDENTIAL_REQUIREMENTS,
  LARRY_GRANT_REQUIREMENTS,
  LARRY_CAPABILITIES,
} from './larry/definition';

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

/**
 * Static grant requirements for Myra. Derived from
 * `buildPersonalAgentGrantRequirements` but with the dynamic per-workbench
 * `tenant:<id>:deliver` entry dropped — that grant depends on the launch-time
 * workbench tenant id and is computed at instance launch, not baked into the
 * seeded definition (CL-1530 locked design decision 2).
 */
const MYRA_STATIC_GRANT_REQUIREMENTS: GrantRequirementType[] = buildPersonalAgentGrantRequirements(
  ''
).filter((g) => !g.resource.startsWith('tenant:'));

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
  kind?: 'personal';
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
 *   - Freddy: FIRECRAWL_CAPABILITIES.tools
 *   - Walter: WALTER_CAPABILITIES.tools
 *   - Hammy:  HAMMY_CAPABILITIES.tools
 */
export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    key: 'myra',
    name: PERSONAL_AGENT_NAME,
    description: 'Your personal AI assistant — always on, context-aware, and ready to help.',
    systemPrompt: PERSONAL_AGENT_DEPLOY_PROMPT,
    credentialRequirements: PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
    grantRequirements: MYRA_STATIC_GRANT_REQUIREMENTS,
    capabilities: { tools: [...PERSONAL_AGENT_BASE_TOOLS] },
    kind: 'personal',
  },
  {
    key: 'oat',
    name: 'Oat',
    description: 'Pulls meeting notes from Granola and surfaces key signals for your pipeline.',
    systemPrompt: GRANOLA_DEPLOY_PROMPT,
    credentialRequirements: GRANOLA_CREDENTIAL_REQUIREMENTS,
    grantRequirements: GRANOLA_GRANT_REQUIREMENTS,
    capabilities: { tools: [...GRANOLA_CAPABILITIES.tools] },
  },
  {
    key: 'loop',
    name: 'Loop',
    description: 'Runs scheduled background tasks on a configurable interval.',
    systemPrompt: LOOP_DEPLOY_PROMPT,
    credentialRequirements: LOOP_CREDENTIAL_REQUIREMENTS,
    grantRequirements: LOOP_GRANT_REQUIREMENTS,
    capabilities: { tools: [...LOOP_DEPLOY_DESCRIPTOR.defaultTools] },
    deployable: false,
  },
  {
    key: 'freddy',
    name: 'Freddy',
    description: 'Web research agent — crawls and extracts structured data from any URL.',
    systemPrompt: FIRECRAWL_DEPLOY_PROMPT,
    credentialRequirements: FIRECRAWL_CREDENTIAL_REQUIREMENTS,
    grantRequirements: FIRECRAWL_GRANT_REQUIREMENTS,
    capabilities: { tools: [...FIRECRAWL_CAPABILITIES.tools] },
  },
  {
    key: 'walter',
    name: 'Walter',
    description: 'Content writer — turns briefs and research into polished GTM collateral.',
    systemPrompt: WALTER_DEPLOY_PROMPT,
    credentialRequirements: WALTER_CREDENTIAL_REQUIREMENTS,
    grantRequirements: WALTER_GRANT_REQUIREMENTS,
    capabilities: { tools: [...WALTER_CAPABILITIES.tools] },
  },
  {
    key: 'hammy',
    name: 'Hammy',
    description:
      'Humanizer — rewrites AI-sounding content to read as human-authored, or scores how human content already reads.',
    systemPrompt: HAMMY_DEPLOY_PROMPT,
    credentialRequirements: HAMMY_CREDENTIAL_REQUIREMENTS,
    grantRequirements: HAMMY_GRANT_REQUIREMENTS,
    capabilities: { tools: [...HAMMY_CAPABILITIES.tools] },
  },
  {
    key: 'bobby',
    name: 'Bobby',
    description:
      'Browser automation agent — navigates real sites, fills forms, and extracts what only a live page can give.',
    systemPrompt: BOBBY_DEPLOY_PROMPT,
    credentialRequirements: BOBBY_CREDENTIAL_REQUIREMENTS,
    grantRequirements: BOBBY_GRANT_REQUIREMENTS,
    capabilities: { tools: [...BOBBY_CAPABILITIES.tools] },
  },
  {
    key: 'lincoln',
    name: 'Lincoln',
    description:
      'LinkedIn writer — drafts substantive, paste-ready posts grounded in field observations and call insights.',
    systemPrompt: LINCOLN_DEPLOY_PROMPT,
    credentialRequirements: LINCOLN_CREDENTIAL_REQUIREMENTS,
    grantRequirements: LINCOLN_GRANT_REQUIREMENTS,
    capabilities: { tools: [...LINCOLN_CAPABILITIES.tools] },
  },
  {
    key: 'geralt',
    name: 'Geralt',
    description: 'Presentation builder — turns briefs and research into Gamma slide decks.',
    systemPrompt: GERALT_DEPLOY_PROMPT,
    credentialRequirements: GERALT_CREDENTIAL_REQUIREMENTS,
    grantRequirements: GERALT_GRANT_REQUIREMENTS,
    capabilities: { tools: [...GERALT_TOOL_NAMES] },
  },
  {
    key: 'larry',
    name: 'Larry',
    description:
      'Research agent — mines Reddit, X, HackerNews, and social platforms for the last 30 days of signal.',
    systemPrompt: LARRY_DEPLOY_PROMPT,
    credentialRequirements: LARRY_CREDENTIAL_REQUIREMENTS,
    grantRequirements: LARRY_GRANT_REQUIREMENTS,
    capabilities: { tools: [...LARRY_CAPABILITIES.tools] },
  },
];
