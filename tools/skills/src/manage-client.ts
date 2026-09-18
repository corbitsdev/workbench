// A minimal client for the workflow-run-authenticated surfaces
// `@corbits/skills-tools`' tools call.
//
// `@corbits/skills`' `createWorkflowSkillRoutes` (formerly
// mounted at `/api/workflow-skills`, serving `list`/`search`/`load` plus
// the `create`/`update` writes) was deleted — skills are native
// `kind:"skill"` hub assets now, and no stock Interchange route yet lets
// a workflow-run bearer identity read or write a skill's content
// (`@intx/hub-api`'s `routes/assets.ts` covers asset metadata and
// package-registry tarballs, not skill content). `listSkills`,
// `loadSkill`, `createSkill`, and `updateSkill` below fail closed with an
// explicit error naming that gap rather than reaching a dead route or
// inventing a result.
//
// `pinSkill` is unaffected: it calls `@corbits/agent-directory`'s
// `createWorkflowSkillPinRoutes` (mounted at `/api/workflow-skill-pins`),
// a live, separate surface this ticket does not touch.
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

const PinResponse = type({ skills: "string[]" });

export type SkillDetail = {
  readonly name: string;
  readonly description: string;
  readonly body: string;
};

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

function skillPinEndpoint(config: SkillsToolClientConfig, path: string): string {
  return `${config.hubAgentDirectoryUrl}/api/workflow-skill-pins${path}`;
}

const NO_STOCK_SKILL_CONTENT_ROUTE =
  "Skill content has no stock Interchange HTTP route: the " +
  "workbench-specific skills registry that used to serve it was removed, " +
  "and no replacement has been added to @intx/hub-api yet.";

/** Every skill this run can see, index-only (name + description, no
 * body). No stock Interchange route serves this yet; fails
 * closed rather than reaching a dead route or reading as an empty
 * registry. */
export function listSkills(_config: SkillsToolClientConfig): Promise<readonly SkillIndexEntry[]> {
  return Promise.reject(new Error(NO_STOCK_SKILL_CONTENT_ROUTE));
}

/** Loads one skill's full body by name. No stock Interchange route
 * serves this yet; fails closed rather than fabricating
 * content. */
export function loadSkill(_config: SkillsToolClientConfig, _name: string): Promise<SkillDetail> {
  return Promise.reject(new Error(NO_STOCK_SKILL_CONTENT_ROUTE));
}

/** Creates a new, always tenant-scoped skill. No stock Interchange route
 * accepts skill content yet; fails closed rather than
 * fabricating success. */
export function createSkill(
  _config: SkillsToolClientConfig,
  _input: {
    readonly name: string;
    readonly description: string;
    readonly body: string;
  },
): Promise<SkillSummary> {
  return Promise.reject(new Error(NO_STOCK_SKILL_CONTENT_ROUTE));
}

/** Republishes an existing skill's body. No stock Interchange route
 * accepts skill content yet; fails closed rather than
 * fabricating success. */
export function updateSkill(
  _config: SkillsToolClientConfig,
  _input: {
    readonly name: string;
    readonly body: string;
    readonly description?: string;
  },
): Promise<SkillSummary> {
  return Promise.reject(new Error(NO_STOCK_SKILL_CONTENT_ROUTE));
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
    throw new Error(`Pin-skill response did not match the expected shape: ${parsed.summary}`);
  }
  return parsed.skills;
}
