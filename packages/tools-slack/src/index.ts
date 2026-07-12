import { type } from "arktype";
import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";

export type SlackFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

const SlackToolsConfig = type({
  botToken: "string",
  "baseUrl?": "string",
  "fetcher?": "unknown",
});

export type SlackToolsConfig = typeof SlackToolsConfig.infer & {
  fetcher?: SlackFetch;
};

const DEFAULT_BASE_URL = "https://slack.com/api";

// Slack Web API envelope: every method returns `ok`; on failure `error` carries
// the machine code (e.g. `not_in_channel`, `channel_not_found`).
const SlackEnvelope = type({
  ok: "boolean",
  "error?": "string",
});

const SlackChannel = type({
  id: "string",
  "name?": "string",
  "is_member?": "boolean",
});
type SlackChannel = typeof SlackChannel.infer;

const SlackResponseMetadata = type({
  "next_cursor?": "string",
});

const SlackConversationsListResponse = SlackEnvelope.and({
  "channels?": SlackChannel.array(),
  "response_metadata?": SlackResponseMetadata,
});

const SlackMessage = type({
  "ts?": "string",
  "user?": "string",
  "text?": "string",
  "thread_ts?": "string",
  "bot_id?": "string",
});
type SlackMessage = typeof SlackMessage.infer;

const SlackHistoryResponse = SlackEnvelope.and({
  "messages?": SlackMessage.array(),
  "response_metadata?": SlackResponseMetadata,
});

const SlackPostMessageResponse = SlackEnvelope.and({
  "ts?": "string",
  "channel?": "string",
});

// ── Tool arg schemas ──────────────────────────────────────────────────────

const ListChannelsArgs = type({
  "types?": "string",
  "limit?": "number",
  "cursor?": "string",
});

const ChannelHistoryArgs = type({
  channel: "string > 0",
  "thread_ts?": "string",
  "limit?": "number",
  "oldest?": "string",
  "latest?": "string",
});

const PostMessageArgs = type({
  channel: "string > 0",
  text: "string > 0",
  "thread_ts?": "string",
});

const SearchArgs = type({
  query: "string > 0",
  "limit?": "number",
  "channelLimit?": "number",
});

// ── Limits (bounded per the design; slack_search is honest + capped) ────────

const DEFAULT_HISTORY_LIMIT = 30;
const MAX_HISTORY_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 200;
const SEARCH_MAX_CHANNELS = 10;
const SEARCH_MAX_MESSAGES_PER_CHANNEL = 100;
const SEARCH_DEFAULT_MATCHES = 20;
const SEARCH_MAX_MATCHES = 100;
const SEARCH_TIME_BUDGET_MS = 15_000;

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function clampInt(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

function validateConfig(config: SlackToolsConfig): void {
  if (config.botToken.length === 0) {
    throw new Error("Slack botToken is required");
  }
  if (config.baseUrl !== undefined) {
    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error("Slack baseUrl must be a valid URL");
    }
  }
}

// Slack channel ids are uppercase and prefixed (C/G/D/…). Anything else is
// treated as a human channel name (`#general` or `general`) to be resolved.
function looksLikeChannelId(value: string): boolean {
  return /^[CGD][A-Z0-9]{6,}$/.test(value);
}

async function slackCall(
  config: SlackToolsConfig,
  method: string,
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const fetcher = config.fetcher ?? fetch;
  const url = `${normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL)}/${method}`;
  const body = new URLSearchParams(params).toString();
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.botToken}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body,
    signal,
  } satisfies RequestInit);

  if (!response.ok) {
    throw new Error(`Slack API HTTP error: ${response.status}`);
  }

  const data: unknown = await response.json();
  const envelope = SlackEnvelope(data);
  if (envelope instanceof type.errors) {
    throw new Error("Slack response was not a valid API envelope");
  }
  if (!envelope.ok) {
    throw new Error(slackErrorMessage(method, envelope.error));
  }
  return data as Record<string, unknown>;
}

function slackErrorMessage(method: string, code: string | undefined): string {
  if (code === "not_in_channel" || code === "channel_not_found") {
    return `Slack ${method} failed: ${code ?? "unknown"} — invite the bot to the channel before reading it`;
  }
  return `Slack ${method} error: ${code ?? "unknown"}`;
}

// ── list channels ───────────────────────────────────────────────────────────

async function listChannels(
  config: SlackToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const parsed = ListChannelsArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(parsed.summary);
  }
  const limit = clampInt(parsed.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const params: Record<string, string> = {
    types:
      parsed.types && parsed.types.length > 0 ? parsed.types : "public_channel",
    limit: String(limit),
    exclude_archived: "true",
  };
  if (parsed.cursor !== undefined && parsed.cursor.length > 0) {
    params.cursor = parsed.cursor;
  }
  const data = await slackCall(config, "conversations.list", params, signal);
  const list = SlackConversationsListResponse(data);
  if (list instanceof type.errors) {
    throw new Error("Slack conversations.list returned an unexpected shape");
  }
  return {
    channels: (list.channels ?? []).map((c) => ({
      id: c.id,
      name: c.name ?? "",
      isMember: c.is_member ?? false,
    })),
    nextCursor: list.response_metadata?.next_cursor || undefined,
  };
}

async function resolveChannelId(
  config: SlackToolsConfig,
  channel: string,
  signal: AbortSignal,
): Promise<string> {
  const trimmed = channel.startsWith("#") ? channel.slice(1) : channel;
  if (looksLikeChannelId(trimmed)) {
    return trimmed;
  }
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const params: Record<string, string> = {
      types: "public_channel,private_channel",
      limit: String(MAX_LIST_LIMIT),
      exclude_archived: "true",
    };
    if (cursor) params.cursor = cursor;
    const data = await slackCall(config, "conversations.list", params, signal);
    const list = SlackConversationsListResponse(data);
    if (list instanceof type.errors) {
      throw new Error("Slack conversations.list returned an unexpected shape");
    }
    const match = (list.channels ?? []).find((c) => c.name === trimmed);
    if (match) return match.id;
    cursor = list.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  throw new Error(`Slack channel not found: ${channel}`);
}

// ── channel history ──────────────────────────────────────────────────────────

function normalizeMessages(messages: SlackMessage[]) {
  return messages.map((m) => {
    const item: {
      ts: string;
      user: string;
      text: string;
      threadTs?: string;
    } = {
      ts: m.ts ?? "",
      user: m.user ?? m.bot_id ?? "",
      text: m.text ?? "",
    };
    if (m.thread_ts !== undefined) {
      item.threadTs = m.thread_ts;
    }
    return item;
  });
}

async function getChannelHistory(
  config: SlackToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const parsed = ChannelHistoryArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(parsed.summary);
  }
  const channelId = await resolveChannelId(config, parsed.channel, signal);
  const limit = clampInt(
    parsed.limit,
    DEFAULT_HISTORY_LIMIT,
    MAX_HISTORY_LIMIT,
  );
  const params: Record<string, string> = {
    channel: channelId,
    limit: String(limit),
  };
  if (parsed.oldest !== undefined && parsed.oldest.length > 0) {
    params.oldest = parsed.oldest;
  }
  if (parsed.latest !== undefined && parsed.latest.length > 0) {
    params.latest = parsed.latest;
  }

  const usingReplies =
    parsed.thread_ts !== undefined && parsed.thread_ts.length > 0;
  if (usingReplies) {
    params.ts = parsed.thread_ts as string;
  }
  const method = usingReplies
    ? "conversations.replies"
    : "conversations.history";
  const data = await slackCall(config, method, params, signal);
  const history = SlackHistoryResponse(data);
  if (history instanceof type.errors) {
    throw new Error(`Slack ${method} returned an unexpected shape`);
  }
  return {
    channel: channelId,
    messages: normalizeMessages(history.messages ?? []),
  };
}

// ── post message (write) ──────────────────────────────────────────────────────

async function postMessage(
  config: SlackToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const parsed = PostMessageArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(parsed.summary);
  }
  const channelId = await resolveChannelId(config, parsed.channel, signal);
  const params: Record<string, string> = {
    channel: channelId,
    text: parsed.text,
  };
  if (parsed.thread_ts !== undefined && parsed.thread_ts.length > 0) {
    params.thread_ts = parsed.thread_ts;
  }
  const data = await slackCall(config, "chat.postMessage", params, signal);
  const posted = SlackPostMessageResponse(data);
  if (posted instanceof type.errors) {
    throw new Error("Slack chat.postMessage returned an unexpected shape");
  }
  return {
    ok: true,
    channel: posted.channel ?? channelId,
    ts: posted.ts ?? "",
  };
}

// ── bounded search ────────────────────────────────────────────────────────────

async function search(
  config: SlackToolsConfig,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const parsed = SearchArgs(args);
  if (parsed instanceof type.errors) {
    throw new Error(parsed.summary);
  }
  const maxMatches = clampInt(
    parsed.limit,
    SEARCH_DEFAULT_MATCHES,
    SEARCH_MAX_MATCHES,
  );
  const channelLimit = clampInt(
    parsed.channelLimit,
    SEARCH_MAX_CHANNELS,
    SEARCH_MAX_CHANNELS,
  );
  const needle = parsed.query.toLowerCase();
  const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;

  const memberData = await slackCall(
    config,
    "users.conversations",
    {
      types: "public_channel,private_channel",
      limit: String(MAX_LIST_LIMIT),
      exclude_archived: "true",
    },
    signal,
  );
  const memberList = SlackConversationsListResponse(memberData);
  if (memberList instanceof type.errors) {
    throw new Error("Slack users.conversations returned an unexpected shape");
  }
  const channels = (memberList.channels ?? []).slice(0, channelLimit);

  const matches: {
    channel: string;
    channelName: string;
    ts: string;
    user: string;
    text: string;
  }[] = [];

  for (const channel of channels) {
    if (matches.length >= maxMatches || Date.now() >= deadline) break;
    const data = await slackCall(
      config,
      "conversations.history",
      {
        channel: channel.id,
        limit: String(SEARCH_MAX_MESSAGES_PER_CHANNEL),
      },
      signal,
    );
    const history = SlackHistoryResponse(data);
    if (history instanceof type.errors) continue;
    for (const message of history.messages ?? []) {
      if (matches.length >= maxMatches) break;
      const text = message.text ?? "";
      if (text.toLowerCase().includes(needle)) {
        matches.push({
          channel: channel.id,
          channelName: channel.name ?? "",
          ts: message.ts ?? "",
          user: message.user ?? message.bot_id ?? "",
          text,
        });
      }
    }
  }

  return {
    query: parsed.query,
    scannedChannels: channels.length,
    matches,
  };
}

// ── tool definitions ──────────────────────────────────────────────────────────

export const SLACK_LIST_CHANNELS_DEFINITION: ToolDefinition = {
  name: "slack_list_channels",
  description:
    "List the Slack workspace's channels. Returns each channel's id, name, and whether the bot is a member (isMember). The bot must be a member before slack_get_channel_history or slack_search can read a channel.",
  inputSchema: {
    type: "object",
    properties: {
      types: {
        type: "string",
        description:
          "Comma-separated channel types. Default 'public_channel'. Options: public_channel, private_channel.",
      },
      limit: {
        type: "number",
        description: "Max channels to return (1-200, default 100).",
      },
      cursor: {
        type: "string",
        description: "Pagination cursor from a previous call's nextCursor.",
      },
    },
    required: [],
  },
};

export const SLACK_GET_CHANNEL_HISTORY_DEFINITION: ToolDefinition = {
  name: "slack_get_channel_history",
  description:
    "Read recent messages from a Slack channel, or the replies in a thread when thread_ts is set. `channel` accepts a channel id or a name like 'general'. The bot must be invited to the channel first.",
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel id (e.g. C012AB3CD) or name (e.g. general).",
      },
      thread_ts: {
        type: "string",
        description:
          "Optional parent message ts to read a thread's replies instead of channel history.",
      },
      limit: {
        type: "number",
        description: "Max messages to return (1-100, default 30).",
      },
      oldest: {
        type: "string",
        description: "Optional Slack ts lower bound (inclusive).",
      },
      latest: {
        type: "string",
        description: "Optional Slack ts upper bound (inclusive).",
      },
    },
    required: ["channel"],
  },
};

export const SLACK_POST_MESSAGE_DEFINITION: ToolDefinition = {
  name: "slack_post_message",
  description:
    "Post a message to a Slack channel or thread. `channel` accepts a channel id or name; set thread_ts to reply in a thread. This posts publicly and cannot be undone.",
  inputSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Channel id (e.g. C012AB3CD) or name (e.g. general).",
      },
      text: {
        type: "string",
        description: "Message text. Slack mrkdwn is supported.",
      },
      thread_ts: {
        type: "string",
        description: "Optional parent message ts to reply in a thread.",
      },
    },
    required: ["channel", "text"],
  },
};

export const SLACK_SEARCH_DEFINITION: ToolDefinition = {
  name: "slack_search",
  description:
    "Keyword search across the channels the bot is a member of. Bounded: scans up to 10 member channels and their last 100 messages, filtering by substring match. This is NOT full-workspace search — it only sees channels the bot has been invited to.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keyword or phrase to match (case-insensitive substring).",
      },
      limit: {
        type: "number",
        description: "Max matching messages to return (1-100, default 20).",
      },
      channelLimit: {
        type: "number",
        description: "Max member channels to scan (1-10, default 10).",
      },
    },
    required: ["query"],
  },
};

type SlackHandler = (
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<string>;

function buildHandler(
  config: SlackToolsConfig,
  run: (
    config: SlackToolsConfig,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<unknown>,
): SlackHandler {
  return async (args, signal) => jsonResult(await run(config, args, signal));
}

const HANDLERS: Record<
  string,
  {
    definition: ToolDefinition;
    run: (
      config: SlackToolsConfig,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<unknown>;
  }
> = {
  slack_list_channels: {
    definition: SLACK_LIST_CHANNELS_DEFINITION,
    run: listChannels,
  },
  slack_get_channel_history: {
    definition: SLACK_GET_CHANNEL_HISTORY_DEFINITION,
    run: getChannelHistory,
  },
  slack_post_message: {
    definition: SLACK_POST_MESSAGE_DEFINITION,
    run: postMessage,
  },
  slack_search: {
    definition: SLACK_SEARCH_DEFINITION,
    run: search,
  },
};

export function createSlackTools(config: SlackToolsConfig): AgentTool[] {
  validateConfig(config);
  return Object.values(HANDLERS).map(({ definition, run }) => ({
    kind: "string" as const,
    definition,
    handler: buildHandler(config, run),
  }));
}

function createSlackToolFor(
  config: SlackToolsConfig,
  definition: ToolDefinition,
): AgentTool[] {
  validateConfig(config);
  const spec = HANDLERS[definition.name];
  if (!spec) {
    throw new Error(`Unknown Slack tool: ${definition.name}`);
  }
  return [
    {
      kind: "string",
      definition,
      handler: buildHandler(config, spec.run),
    },
  ];
}

function configFromCredential(config: {
  apiKey: string;
  baseURL: string;
}): SlackToolsConfig {
  const resolved: SlackToolsConfig = { botToken: config.apiKey };
  if (config.baseURL && config.baseURL.length > 0) {
    resolved.baseUrl = config.baseURL;
  }
  return resolved;
}

/**
 * Hub tool registry entries for slack. Each entry declares the tool definition,
 * the Interchange provider name for credential resolution, and a factory that
 * returns the AgentTool handlers given resolved credentials (`apiKey` = bot
 * token, `baseURL` = Slack API base).
 *
 * Spread into the hub's KNOWN_TOOLS to register.
 */
export const SLACK_HUB_TOOLS = {
  slack_list_channels: {
    sideEffect: "read" as const,
    definition: SLACK_LIST_CHANNELS_DEFINITION,
    providerName: "slack" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createSlackToolFor(
        configFromCredential(config),
        SLACK_LIST_CHANNELS_DEFINITION,
      ),
  },
  slack_get_channel_history: {
    sideEffect: "read" as const,
    definition: SLACK_GET_CHANNEL_HISTORY_DEFINITION,
    providerName: "slack" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createSlackToolFor(
        configFromCredential(config),
        SLACK_GET_CHANNEL_HISTORY_DEFINITION,
      ),
  },
  slack_search: {
    sideEffect: "read" as const,
    definition: SLACK_SEARCH_DEFINITION,
    providerName: "slack" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createSlackToolFor(configFromCredential(config), SLACK_SEARCH_DEFINITION),
  },
  slack_post_message: {
    sideEffect: "write" as const,
    definition: SLACK_POST_MESSAGE_DEFINITION,
    providerName: "slack" as const,
    createTools: (config: { apiKey: string; baseURL: string }) =>
      createSlackToolFor(
        configFromCredential(config),
        SLACK_POST_MESSAGE_DEFINITION,
      ),
  },
};
