// A minimal client for the two workflow-run-authenticated surfaces
// `create_agent`/`list_agents` reach: `@corbits/agent-directory`'s
// `createWorkflowAgentCreateRoutes` (`POST/GET .../definitions`) and
// `@corbits/chat`'s `createWorkflowParticipantRoutes`
// (`POST .../participants/invite`) — this bundle's execution half,
// mirroring `@corbits/capability-tools`' `client.ts` exactly: same
// auth-header shape, same error-handling, same arktype-response-parsing
// pattern.
//
// Two hub URLs, deliberately not one: `hubAgentDirectoryUrl` reaches
// `@corbits/agent-directory`'s workflow-create-routes,
// `hubChatUrl` reaches `@corbits/chat`'s workflow-participant-routes.
// They are very likely the same physical hub origin in every real
// deployment, but this bundle never assumes that — each surface
// declares its own env key, mirroring how every other tool bundle in
// this codebase (`@corbits/memory-tools`'s `hubMemoryUrl`,
// `@corbits/capability-tools`'s `hubCapabilitiesUrl`) declares its own
// `hub<X>Url` rather than a shared value.
import { type } from "arktype";

export interface AgentDirectoryToolClientConfig {
  readonly hubAgentDirectoryUrl: string;
  readonly hubChatUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface CreateAgentDefinitionRequest {
  readonly name: string;
  readonly handle: string;
  readonly systemPrompt: string;
  readonly model?: string;
  readonly skills?: readonly string[];
  readonly toolPackagePins?: readonly string[];
}

export interface CreatedAgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** The create route serializes `workflow_definition.current_version`,
   * a `text` DB column, verbatim — always a string on the wire, never
   * a number (CL-6480: parsing this as `"number"` made every genuine
   * success fail this schema and read as a create failure). */
  readonly currentVersion: string;
  readonly status: string;
  readonly skills: readonly string[];
  /** Set when `model` was requested but the tenant's catalog didn't
   * offer it, so the route substituted its default (or left the
   * definition modelless) instead of baking in a name that can never
   * resolve (CL-6477). `null` when the requested model — or its
   * absence — needed no substitution. */
  readonly modelNote: string | null;
}

export interface ListedAgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

export interface InvitedParticipant {
  readonly address: string;
  readonly definitionId: string;
  readonly handle: string;
}

/** Response from `POST .../participants/mint-dm` — the specialist's own
 * 1:1 chat workbench plus the launched participant identity. */
export interface MintedAgentDm {
  readonly workbenchId: string;
  readonly address: string;
  readonly definitionId: string;
  readonly handle: string;
}

function authHeaders(
  config: AgentDirectoryToolClientConfig,
): Record<string, string> {
  return {
    authorization: `Bearer ${config.sidecarToken}`,
    "x-workflow-run-address": config.address,
  };
}

/** Pulls `error.message` out of a Hono `app.onError` envelope
 * (`{error: {code, message}}`), if `body` matches that shape — same
 * shape `@corbits/capability-tools`' client reads. */
function errorMessageFrom(body: unknown): string | undefined {
  if (body === null || typeof body !== "object" || !("error" in body)) {
    return undefined;
  }
  const error = (body as { error: unknown }).error;
  if (error === null || typeof error !== "object" || !("message" in error)) {
    return undefined;
  }
  const message = (error as { message: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  return errorMessageFrom(body) ?? fallback;
}

const CreatedAgentDefinitionResponse = type({
  id: "string",
  name: "string",
  description: "string | null",
  currentVersion: "string",
  status: "string",
  skills: "string[]",
  modelNote: "string | null",
});

/** Thrown when the create-agent route rejects the request — a bad
 * handle, an unavailable `toolPackagePins` entry, or a duplicate
 * handle — as distinct from a bare transport/HTTP failure, so a caller
 * can report honestly why creation didn't happen. */
export class CreateAgentDefinitionError extends Error {}

export async function createAgentDefinition(
  config: AgentDirectoryToolClientConfig,
  input: CreateAgentDefinitionRequest,
): Promise<CreatedAgentDefinition> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubAgentDirectoryUrl}/api/workflow-agent-directory/definitions`,
    {
      method: "POST",
      headers: { ...authHeaders(config), "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (response.status === 400 || response.status === 409) {
    throw new CreateAgentDefinitionError(
      await readErrorMessage(
        response,
        `Creating the agent failed: ${response.status}`,
      ),
    );
  }
  if (!response.ok) {
    throw new Error(
      `Creating the agent failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = CreatedAgentDefinitionResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Create-agent response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}

const ListedAgentDefinitionsResponse = type({
  definitions: type({
    id: "string",
    name: "string",
    description: "string | null",
  }).array(),
});

export async function listAgentDefinitions(
  config: AgentDirectoryToolClientConfig,
): Promise<readonly ListedAgentDefinition[]> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubAgentDirectoryUrl}/api/workflow-agent-directory/definitions`,
    { headers: authHeaders(config) },
  );
  if (!response.ok) {
    throw new Error(
      `Listing agents failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = ListedAgentDefinitionsResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `List-agents response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed.definitions;
}

const InvitedParticipantResponse = type({
  address: "string",
  definitionId: "string",
  handle: "string",
});

/** Thrown when the caller's run has no channel to invite into — the
 * workflow-participant route's "not a participant of any channel" 404 —
 * distinct from a bare transport/HTTP failure so `create_agent` can
 * report the created-but-not-invited half-failure honestly rather than
 * a generic error. */
export class NoOwnChannelError extends Error {}

export async function inviteParticipant(
  config: AgentDirectoryToolClientConfig,
  definitionId: string,
): Promise<InvitedParticipant> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubChatUrl}/api/workflow-chat/participants/invite`,
    {
      method: "POST",
      headers: { ...authHeaders(config), "content-type": "application/json" },
      body: JSON.stringify({ definitionId }),
    },
  );
  if (response.status === 404) {
    throw new NoOwnChannelError(
      await readErrorMessage(
        response,
        "The caller has no channel of its own to invite into",
      ),
    );
  }
  if (!response.ok) {
    throw new Error(
      `Inviting the agent failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = InvitedParticipantResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Invite response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}

/** Thrown when the caller's run has no own workbench to mint a DM
 * against — the workflow-participant mint-dm route's 404 — distinct
 * from a bare transport/HTTP failure so `create_agent` can report the
 * created-but-not-minted half-failure honestly rather than a generic
 * error. */
export class NoOwnWorkbenchError extends Error {}

const MintedAgentDmResponse = type({
  workbenchId: "string",
  address: "string",
  definitionId: "string",
  handle: "string",
});

export async function mintAgentDm(
  config: AgentDirectoryToolClientConfig,
  definitionId: string,
): Promise<MintedAgentDm> {
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(
    `${config.hubChatUrl}/api/workflow-chat/participants/mint-dm`,
    {
      method: "POST",
      headers: { ...authHeaders(config), "content-type": "application/json" },
      body: JSON.stringify({ definitionId }),
    },
  );
  if (response.status === 404) {
    throw new NoOwnWorkbenchError(
      await readErrorMessage(
        response,
        "The caller has no own workbench to mint a DM against",
      ),
    );
  }
  if (!response.ok) {
    throw new Error(
      `Minting the agent DM failed: ${response.status} ${response.statusText}`,
    );
  }
  const body: unknown = await response.json();
  const parsed = MintedAgentDmResponse(body);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Mint-DM response did not match the expected shape: ${parsed.summary}`,
    );
  }
  return parsed;
}
