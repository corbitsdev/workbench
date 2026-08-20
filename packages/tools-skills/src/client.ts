// A minimal client for the sanctioned workflow-skills HTTP surface
// (`@corbits/skills`' `createWorkflowSkillRoutes`): list, search, and
// load against the tenant's skill registry. Authenticates with the
// sidecar's own bearer token plus the run's own mailbox address — both
// already reach a workflow-process child's tool env — never a database
// handle, and never a model-supplied tenant or principal.
//
// Every function throws on any transport, HTTP, or shape failure. There
// is deliberately no degraded path: a registry that cannot be reached
// must never read as "this workbench has no skills", because an agent
// told its skills are absent will confidently proceed without them.
import { type } from "arktype";

/**
 * The subset of `fetch` this client uses. Narrower than `typeof fetch`
 * so a test double is a plain function rather than something that has to
 * reimplement the runtime's extra members.
 */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface WorkflowSkillsClientConfig {
  readonly hubSkillsUrl: string;
  readonly sidecarToken: string;
  readonly runAddress: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
}

export type SkillIndexItem = {
  readonly name: string;
  readonly description: string;
};

export type LoadedSkill = SkillIndexItem & { readonly body: string };

const SkillIndexResponse = type({
  data: type({ name: "string", description: "string" }).array(),
});

const LoadedSkillResponse = type({
  data: { name: "string", description: "string", body: "string" },
});

function authHeaders(
  config: WorkflowSkillsClientConfig,
): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.runAddress,
  };
}

function endpoint(config: WorkflowSkillsClientConfig, path: string): string {
  return `${config.hubSkillsUrl}/api/workflow-skills${path}`;
}

function assertCredentials(config: WorkflowSkillsClientConfig): void {
  if (config.sidecarToken === "") {
    throw new Error("Skill registry call has no sidecar token to present");
  }
  if (config.runAddress === "") {
    throw new Error("Skill registry call has no run address to present");
  }
  if (config.hubSkillsUrl === "") {
    throw new Error("Skill registry call has no hub URL to reach");
  }
}

async function parseIndex(
  response: Response,
  label: string,
): Promise<readonly SkillIndexItem[]> {
  if (!response.ok) {
    throw new Error(
      `${label} failed: ${String(response.status)} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = SkillIndexResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `${label} response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}

/** Lists every skill the run's principal can see. */
export async function listSkills(
  config: WorkflowSkillsClientConfig,
): Promise<readonly SkillIndexItem[]> {
  assertCredentials(config);
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(endpoint(config, "/list"), {
    headers: authHeaders(config),
  });
  return parseIndex(response, "Skill list");
}

/** Searches the visible skills by name and description. */
export async function searchSkills(
  config: WorkflowSkillsClientConfig,
  query: string,
): Promise<readonly SkillIndexItem[]> {
  assertCredentials(config);
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(endpoint(config, "/search"), {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return parseIndex(response, "Skill search");
}

/** Reads one skill's full instructions. */
export async function loadSkill(
  config: WorkflowSkillsClientConfig,
  name: string,
): Promise<LoadedSkill> {
  assertCredentials(config);
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(endpoint(config, "/load"), {
    method: "POST",
    headers: { ...authHeaders(config), "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw new Error(
      `Skill load failed: ${String(response.status)} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = LoadedSkillResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Skill load response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.data;
}
