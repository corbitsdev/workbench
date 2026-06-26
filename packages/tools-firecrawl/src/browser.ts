import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  InteractArgsSchema,
  RequiredIdArgsSchema,
  firecrawlFetchJSON,
  parseArgs,
  resolveConfig,
  stringTool,
  type FirecrawlToolsConfig,
  type ResolvedFirecrawlConfig,
} from "./shared";

async function interact(
  config: ResolvedFirecrawlConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseArgs(InteractArgsSchema, rawArgs, "firecrawl_interact");

  const body: Record<string, unknown> = {};
  if (args.code !== undefined) {
    body.code = args.code;
  }
  if (args.prompt !== undefined) {
    body.prompt = args.prompt;
  }
  if (args.language !== undefined) {
    body.language = args.language;
  }
  if (args.timeout !== undefined) {
    body.timeout = args.timeout;
  }

  return firecrawlFetchJSON(
    config,
    {
      method: "POST",
      path: `/scrape/${encodeURIComponent(args.jobId)}/interact`,
      body,
    },
    signal,
  );
}

async function listSessions(
  config: ResolvedFirecrawlConfig,
  _args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  return firecrawlFetchJSON(
    config,
    { method: "GET", path: "/browser/sessions" },
    signal,
  );
}

async function deleteSession(
  config: ResolvedFirecrawlConfig,
  rawArgs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const { id } = parseArgs(
    RequiredIdArgsSchema,
    rawArgs,
    "firecrawl_browser_session_delete",
  );
  return firecrawlFetchJSON(
    config,
    { method: "DELETE", path: `/browser/sessions/${encodeURIComponent(id)}` },
    signal,
  );
}

export const FIRECRAWL_INTERACT_DEFINITION: ToolDefinition = {
  name: "firecrawl_interact",
  description:
    "Interact with a browser session bound to a previous scrape job. Execute code or an AI prompt to click, fill forms, or extract data from dynamic content.",
  inputSchema: {
    type: "object",
    properties: {
      jobId: {
        type: "string",
        description: "The scrape job id that created the browser session.",
      },
      code: {
        type: "string",
        description: "Code to execute in the browser sandbox.",
      },
      prompt: {
        type: "string",
        description:
          "Natural-language instruction for the AI agent to perform in the browser.",
      },
      language: {
        type: "string",
        description: 'Language for the code block, e.g. "node".',
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds for the interaction.",
      },
    },
    required: ["jobId"],
  },
};

export const FIRECRAWL_BROWSER_SESSIONS_LIST_DEFINITION: ToolDefinition = {
  name: "firecrawl_browser_sessions_list",
  description: "List active Firecrawl browser sessions.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const FIRECRAWL_BROWSER_SESSION_DELETE_DEFINITION: ToolDefinition = {
  name: "firecrawl_browser_session_delete",
  description: "Delete a Firecrawl browser session by id.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Browser session id to delete.",
      },
    },
    required: ["id"],
  },
};

export const BROWSER_DEFINITIONS: ToolDefinition[] = [
  FIRECRAWL_INTERACT_DEFINITION,
  FIRECRAWL_BROWSER_SESSIONS_LIST_DEFINITION,
  FIRECRAWL_BROWSER_SESSION_DELETE_DEFINITION,
];

export function createBrowserTools(config: FirecrawlToolsConfig): AgentTool[] {
  const resolved = resolveConfig(config);

  return [
    stringTool(FIRECRAWL_INTERACT_DEFINITION, (args, signal) =>
      interact(resolved, args, signal),
    ),
    stringTool(FIRECRAWL_BROWSER_SESSIONS_LIST_DEFINITION, (_args, signal) =>
      listSessions(resolved, _args, signal),
    ),
    stringTool(FIRECRAWL_BROWSER_SESSION_DELETE_DEFINITION, (args, signal) =>
      deleteSession(resolved, args, signal),
    ),
  ];
}
