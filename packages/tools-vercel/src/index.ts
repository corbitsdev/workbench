import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

export type VercelFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type VercelToolsConfig = {
  apiKey: string;
  baseUrl?: string;
  fetcher?: VercelFetch;
};

const DEFAULT_BASE_URL = "https://api.vercel.com";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_STATIC_FILE_BYTES = 4_500_000;

const VercelProjectSchema = type({
  id: "string",
  name: "string",
  "framework?": "string | null",
  "updatedAt?": "number | string",
});

const VercelProjectsResponse = type({
  projects: VercelProjectSchema.array(),
});

const VercelDeploymentSchema = type({
  uid: "string",
  "name?": "string",
  "url?": "string",
  "state?": "string",
  "readyState?": "string",
  "createdAt?": "number | string",
  "target?": "string | null",
});

const VercelDeploymentsResponse = type({
  deployments: VercelDeploymentSchema.array(),
});

const VercelDeploymentResponse = type({
  id: "string",
  "url?": "string",
  "name?": "string",
  "readyState?": "string",
  "inspectUrl?": "string",
});

const ListProjectsArgs = type({
  "teamId?": "string > 0",
  "limit?": "number",
});

const ListDeploymentsArgs = type({
  "projectId?": "string > 0",
  "teamId?": "string > 0",
  "limit?": "number",
});

const DeployStaticFileArgs = type({
  projectName: "string > 0",
  filePath: "string > 0",
  html: "string > 0",
  "teamId?": "string > 0",
  "target?": "'production' | 'preview'",
});

export const VERCEL_LIST_PROJECTS_DEFINITION: ToolDefinition = {
  name: "vercel_list_projects",
  description:
    "List Vercel projects visible to the configured token. Read-only. Optionally pass teamId and limit.",
  inputSchema: {
    type: "object",
    properties: {
      teamId: { type: "string", description: "Optional Vercel team ID." },
      limit: {
        type: "number",
        description: "Maximum projects to return, 1-100.",
      },
    },
  },
};

export const VERCEL_LIST_DEPLOYMENTS_DEFINITION: ToolDefinition = {
  name: "vercel_list_deployments",
  description:
    "List recent Vercel deployments visible to the configured token. Read-only. Optionally scope by projectId and teamId.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "Optional Vercel project ID." },
      teamId: { type: "string", description: "Optional Vercel team ID." },
      limit: {
        type: "number",
        description: "Maximum deployments to return, 1-100.",
      },
    },
  },
};

export const VERCEL_DEPLOY_STATIC_FILE_DEFINITION: ToolDefinition = {
  name: "vercel_deploy_static_file",
  description:
    'Deploy one static HTML file to a public Vercel URL. This is an irreversible write action that publishes content the user can see. Before calling it you MUST obtain explicit human approval through the ask_principal tool (action describing the deploy, resource "vercel://deploy") and only proceed once the principal approves — never deploy on your own judgement. Defaults to a preview deployment; only request target "production" when the human explicitly approves a production deploy.',
  inputSchema: {
    type: "object",
    properties: {
      projectName: {
        type: "string",
        description: "Vercel project/name for the deployment.",
      },
      filePath: {
        type: "string",
        description:
          "Path for the deployed file, for example index.html or demos/page.html.",
      },
      html: {
        type: "string",
        description:
          "The complete HTML file content the human approved for deployment.",
      },
      teamId: { type: "string", description: "Optional Vercel team ID." },
      target: {
        type: "string",
        enum: ["production", "preview"],
        description:
          "Deployment target. Defaults to preview; production requires explicit human approval.",
      },
    },
    required: ["projectName", "filePath", "html"],
  },
};

function validateConfig(config: VercelToolsConfig): void {
  if (config.apiKey.length === 0) {
    throw new Error("Vercel apiKey is required");
  }
  if (config.baseUrl !== undefined) {
    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error("Vercel baseUrl must be a valid URL");
    }
  }
}

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(limit, MAX_LIMIT);
}

function apiUrl(config: VercelToolsConfig, path: string): URL {
  return new URL(path, config.baseUrl ?? DEFAULT_BASE_URL);
}

function withTeamId(url: URL, teamId: string | undefined): void {
  if (teamId !== undefined) {
    url.searchParams.set("teamId", teamId);
  }
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (text.length === 0) {
    return response.statusText;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      "message" in parsed.error &&
      typeof parsed.error.message === "string"
    ) {
      return parsed.error.message;
    }
  } catch {
    return text;
  }
  return text;
}

async function fetchVercelJson(
  config: VercelToolsConfig,
  url: URL,
  init: RequestInit,
): Promise<unknown> {
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!response.ok) {
    throw new Error(
      `Vercel API error: ${response.status} ${await readError(response)}`,
    );
  }
  return response.json();
}

async function listProjects(
  config: VercelToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = ListProjectsArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(`vercel_list_projects: ${parsed.summary}`);
  }

  const url = apiUrl(config, "/v9/projects");
  url.searchParams.set("limit", String(normalizeLimit(parsed.limit)));
  withTeamId(url, parsed.teamId);

  const raw = await fetchVercelJson(config, url, { method: "GET", signal });
  const response = VercelProjectsResponse(raw);
  if (response instanceof type.errors) {
    throw new Error(`Vercel projects response invalid: ${response.summary}`);
  }
  return jsonResult(response.projects);
}

async function listDeployments(
  config: VercelToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = ListDeploymentsArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(`vercel_list_deployments: ${parsed.summary}`);
  }

  const url = apiUrl(config, "/v6/deployments");
  url.searchParams.set("limit", String(normalizeLimit(parsed.limit)));
  if (parsed.projectId !== undefined) {
    url.searchParams.set("projectId", parsed.projectId);
  }
  withTeamId(url, parsed.teamId);

  const raw = await fetchVercelJson(config, url, { method: "GET", signal });
  const response = VercelDeploymentsResponse(raw);
  if (response instanceof type.errors) {
    throw new Error(`Vercel deployments response invalid: ${response.summary}`);
  }
  return jsonResult(response.deployments);
}

function normalizeFilePath(filePath: string): string {
  const normalized = filePath.replace(/^\/+/, "");
  if (normalized.length === 0 || normalized.includes("..")) {
    throw new Error("filePath must be a relative file path without '..'");
  }
  return normalized;
}

async function deployStaticFile(
  config: VercelToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  const parsed = DeployStaticFileArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(`vercel_deploy_static_file: ${parsed.summary}`);
  }

  const file = normalizeFilePath(parsed.filePath);
  const size = new TextEncoder().encode(parsed.html).byteLength;
  if (size > MAX_STATIC_FILE_BYTES) {
    throw new Error(`HTML file is too large for this tool (${size} bytes)`);
  }

  const url = apiUrl(config, "/v13/deployments");
  withTeamId(url, parsed.teamId);

  const raw = await fetchVercelJson(config, url, {
    method: "POST",
    signal,
    body: JSON.stringify({
      name: parsed.projectName,
      target: parsed.target ?? "preview",
      projectSettings: { framework: null },
      files: [
        {
          file,
          data: Buffer.from(parsed.html, "utf8").toString("base64"),
          encoding: "base64",
        },
      ],
    }),
  });
  const response = VercelDeploymentResponse(raw);
  if (response instanceof type.errors) {
    throw new Error(`Vercel deployment response invalid: ${response.summary}`);
  }
  return jsonResult({
    ...response,
    url: response.url !== undefined ? `https://${response.url}` : undefined,
  });
}

export function createVercelTools(config: VercelToolsConfig): AgentTool[] {
  validateConfig(config);
  return [
    {
      kind: "string",
      definition: VERCEL_LIST_PROJECTS_DEFINITION,
      handler: (args, signal) => listProjects(config, args, signal),
    },
    {
      kind: "string",
      definition: VERCEL_LIST_DEPLOYMENTS_DEFINITION,
      handler: (args, signal) => listDeployments(config, args, signal),
    },
    {
      kind: "string",
      definition: VERCEL_DEPLOY_STATIC_FILE_DEFINITION,
      handler: (args, signal) => deployStaticFile(config, args, signal),
    },
  ];
}

export const VERCEL_HUB_TOOLS = {
  vercel_list_projects: {
    definition: VERCEL_LIST_PROJECTS_DEFINITION,
    providerName: "vercel" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createVercelTools({ apiKey: config.apiKey, baseUrl: config.baseURL }),
  },
  vercel_list_deployments: {
    definition: VERCEL_LIST_DEPLOYMENTS_DEFINITION,
    providerName: "vercel" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createVercelTools({ apiKey: config.apiKey, baseUrl: config.baseURL }),
  },
  vercel_deploy_static_file: {
    definition: VERCEL_DEPLOY_STATIC_FILE_DEFINITION,
    providerName: "vercel" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createVercelTools({ apiKey: config.apiKey, baseUrl: config.baseURL }),
  },
};
