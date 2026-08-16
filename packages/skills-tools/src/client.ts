// A minimal client for the two workflow-run-authenticated surfaces
// `@corbits/skills-tools`' tools call: `@corbits/skills`'
// `createWorkflowSkillRoutes` (mounted in `apps/hub` at
// `/api/workflow-skills`, already serving read-only `list`/`search`/
// `load` — this client adds the two write endpoints,
// `POST /create`/`POST /update`, that same route file now also serves)
// and `@corbits/agent-directory`'s `createWorkflowSkillPinRoutes`
// (mounted at `/api/workflow-skill-pins`, `POST /pin`).
//
// Same auth-header/error-handling/arktype-parsing shape as
// `@corbits/capability-tools`' `client.ts`: a sidecar bearer token plus
// the run's own address, never a model-supplied identity.
import { type } from "arktype";

export interface SkillsToolClientConfig {
  /** The hub's plain HTTP origin serving `@corbits/skills`' workflow
   * routes — same value `@corbits/memory-tools`' `hubMemoryUrl` and
   * `@corbits/capability-tools`' `hubCapabilitiesUrl` reach the hub
   * through. */
  readonly hubSkillsUrl: string;
  /** The hub's plain HTTP origin serving `@corbits/agent-directory`'s
   * workflow routes. Declared separately from `hubSkillsUrl` even
   * though both currently resolve to the same hub origin in every
   * deployment this repo ships — the two write surfaces belong to
   * different packages, and a host is free to split them apart. */
  readonly hubAgentDirectoryUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export type SkillSummary = {
  readonly assetId: string;
  readonly name: string;
  readonly description: string;
  readonly scope: "private" | "tenant";
  readonly creatorPrincipalId: string;
  readonly updatedAtIso: string;
};

export type SkillIndexEntry = {
  readonly name: string;
  readonly description: string;
};

const SkillSummaryResponse = type({
  data: {
    assetId: "string",
    name: "string",
    description: "string",
    scope: "'private' | 'tenant'",
    creatorPrincipalId: "string",
    updatedAtIso: "string",
  },
});

const SkillIndexResponse = type({
  data: type({ name: "string", description: "string" }).array(),
});

const PinResponse = type({ skills: "string[]" });

function authHeaders(config: SkillsToolClientConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
  };
}

async function postJson(
  config: SkillsToolClientConfig,
  url: string,
  body: unknown,
): Promise<unknown> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(url, {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody: unknown = await response.json().catch(() => undefined);
    throw new Error(
      `${url} failed: ${response.status} ${response.statusText}${
        errorBody === undefined ? "" : ` — ${JSON.stringify(errorBody)}`
      }`,
    );
  }
  return response.json();
}

function skillsEndpoint(config: SkillsToolClientConfig, path: string): string {
  return `${config.hubSkillsUrl}/api/workflow-skills${path}`;
}

function skillPinEndpoint(
  config: SkillsToolClientConfig,
  path: string,
): string {
  return `${config.hubAgentDirectoryUrl}/api/workflow-skill-pins${path}`;
}

/** Every skill this run can see, index-only (name + description, no
 * body) — mirrors `GET /list`'s own shape. */
export async function listSkills(
  config: SkillsToolClientConfig,
): Promise<readonly SkillIndexEntry[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(skillsEndpoint(config, "/list"), {
    headers: authHeaders(config),
  });
  if (!response.ok) {
    throw new Error(
      `Listing skills failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = SkillIndexResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Skill list response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}

/** Creates a new, always tenant-scoped skill. Throws on any transport,
 * HTTP, or shape failure — never fabricates success. */
export async function createSkill(
  config: SkillsToolClientConfig,
  input: {
    readonly name: string;
    readonly description: string;
    readonly body: string;
  },
): Promise<SkillSummary> {
  const body = await postJson(config, skillsEndpoint(config, "/create"), input);
  const parsed = SkillSummaryResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Create-skill response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}

/** Republishes an existing skill's body, optionally its description —
 * an omitted `description` leaves the skill's current one untouched
 * (the route's own `/update` fills it in from the skill it loads
 * first). Throws 404 the same way a bare fetch failure throws: as a
 * plain `Error`, on any skill name this run cannot see or that does
 * not exist. */
export async function updateSkill(
  config: SkillsToolClientConfig,
  input: {
    readonly name: string;
    readonly body: string;
    readonly description?: string;
  },
): Promise<SkillSummary> {
  const body = await postJson(config, skillsEndpoint(config, "/update"), input);
  const parsed = SkillSummaryResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Update-skill response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}

/** Pins a skill name onto any definition in this run's own tenant.
 * Returns that definition's full pinned-skill list after the pin. */
export async function pinSkill(
  config: SkillsToolClientConfig,
  input: { readonly definitionId: string; readonly skillName: string },
): Promise<readonly string[]> {
  const body = await postJson(config, skillPinEndpoint(config, "/pin"), input);
  const parsed = PinResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Pin-skill response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.skills;
}
