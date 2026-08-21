// Turning a turn's tool calls into something a person can read.
//
// The wire carries a tool call as an identifier plus an argument bag plus
// whatever the tool handed back (`ToolTracePart` in `@corbits/chat/parts`,
// assembled by the chat orchestrator from `inferenceDoneBlocks` /
// `toolDoneResult`). None of those three is fit to show anyone: the
// identifier is a symbol (`slack__post_message`), the arguments are JSON,
// and the result is usually a content-block array. This module is the one
// place that translates all three into plain sentences — "Posted a message
// in Slack", "Found 8 results", "Couldn't reach GitHub" — so no surface
// downstream ever has to reach for `JSON.stringify` to say what happened.
//
// Both the live strip (`turn-activity.tsx`, mid-turn) and the persisted
// transcript (`timeline.tsx`) render through here, which is why a phrase
// comes in two tenses: the same call reads "Searching the web for
// "pricing"" while it runs and "Searched the web for "pricing"" once it
// settles.

import type { Part, ToolTracePart } from "@corbits/chat/parts";

export type ToolActivityStatus = "pending" | "running" | "success" | "failed";

/** One tool call, ready to render: no identifiers, no JSON, no tense
 * mismatch with its own status. */
export type ToolActivityRow = {
  readonly key: string;
  /** The raw tool identifier. Never rendered — carried so a row keeps its
   * provenance for tests and debugging. */
  readonly toolName: string;
  readonly phrase: string;
  /** The on-demand detail, already plain text. Undefined when the tool
   * returned nothing legible — a row with no detail offers no disclosure
   * rather than opening onto an empty box. */
  readonly detail: string | undefined;
  readonly status: ToolActivityStatus;
  /** A quiet right-aligned note — elapsed time on a call still running.
   * Absent everywhere else; a settled row has nothing to add. */
  readonly meta?: string;
};

const MAX_PHRASE_ARGUMENT = 48;
const MAX_FAILURE_DETAIL = 240;
const MAX_SUCCESS_DETAIL = 600;

type Tense = "past" | "present";

type Conjugation = { readonly past: string; readonly present: string };

/** The verbs tool names actually start with, in the two forms a transcript
 * needs. Irregulars are why this is a table and not a suffix rule. */
const VERBS: Record<string, Conjugation> = {
  add: { past: "Added", present: "Adding" },
  archive: { past: "Archived", present: "Archiving" },
  browse: { past: "Browsed", present: "Browsing" },
  build: { past: "Built", present: "Building" },
  call: { past: "Called", present: "Calling" },
  cancel: { past: "Cancelled", present: "Cancelling" },
  check: { past: "Checked", present: "Checking" },
  close: { past: "Closed", present: "Closing" },
  create: { past: "Created", present: "Creating" },
  delete: { past: "Deleted", present: "Deleting" },
  deploy: { past: "Deployed", present: "Deploying" },
  download: { past: "Downloaded", present: "Downloading" },
  edit: { past: "Edited", present: "Editing" },
  fetch: { past: "Fetched", present: "Fetching" },
  find: { past: "Found", present: "Finding" },
  get: { past: "Retrieved", present: "Retrieving" },
  glob: { past: "Searched", present: "Searching" },
  grep: { past: "Searched", present: "Searching" },
  list: { past: "Listed", present: "Listing" },
  move: { past: "Moved", present: "Moving" },
  open: { past: "Opened", present: "Opening" },
  post: { past: "Posted", present: "Posting" },
  publish: { past: "Published", present: "Publishing" },
  query: { past: "Queried", present: "Querying" },
  read: { past: "Read", present: "Reading" },
  remove: { past: "Removed", present: "Removing" },
  rename: { past: "Renamed", present: "Renaming" },
  run: { past: "Ran", present: "Running" },
  save: { past: "Saved", present: "Saving" },
  search: { past: "Searched", present: "Searching" },
  send: { past: "Sent", present: "Sending" },
  set: { past: "Set", present: "Setting" },
  update: { past: "Updated", present: "Updating" },
  upload: { past: "Uploaded", present: "Uploading" },
  write: { past: "Wrote", present: "Writing" },
};

/** Providers whose display name isn't just their identifier title-cased. */
const PROVIDER_NAMES: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  linear: "Linear",
  notion: "Notion",
  postgres: "Postgres",
  slack: "Slack",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(
  bag: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = bag?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function providerDisplayName(provider: string): string {
  const known = PROVIDER_NAMES[provider.toLowerCase()];
  if (known !== undefined) return known;
  return titleCase(provider.replace(/[_-]+/g, " "));
}

type ToolIdentity = {
  readonly provider: string | undefined;
  readonly words: readonly string[];
};

/**
 * Splits a tool identifier into the provider it belongs to and the words
 * describing what it does.
 *
 * `mcp_read`/`mcp_call` are the generic MCP dispatch tools
 * (`packages/mcp-tools/src/tool.ts`): every downstream call arrives under
 * one of those two names, with the tool it actually invoked sitting in its
 * `{server, tool}` arguments — so those are read first, or a whole
 * conversation's worth of calls would all read alike.
 */
export function resolveToolIdentity(
  name: string,
  input: unknown,
): ToolIdentity {
  const args = asRecord(input);
  if (name === "mcp_read" || name === "mcp_call") {
    const server = readString(args, "server");
    const tool = readString(args, "tool");
    if (server !== undefined && tool !== undefined) {
      return { provider: server, words: splitToolWords(tool) };
    }
  }
  const namespaced = name.split("__");
  if (namespaced.length > 1 && namespaced[0] !== undefined) {
    return {
      provider: namespaced[0],
      words: splitToolWords(namespaced.slice(1).join("_")),
    };
  }
  const dotted = name.split(".");
  if (dotted.length > 1 && dotted[0] !== undefined) {
    return {
      provider: dotted[0],
      words: splitToolWords(dotted.slice(1).join("_")),
    };
  }
  return { provider: undefined, words: splitToolWords(name) };
}

function splitToolWords(name: string): readonly string[] {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced
    .split(/[_\-.\s]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word !== "");
}

/** A file path's last segment — the part a person recognises. */
function basename(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== "");
  const last = segments[segments.length - 1];
  return last ?? path;
}

function hostname(url: string): string | undefined {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  const host = match?.[1];
  if (host === undefined) return undefined;
  return host.replace(/^www\./, "");
}

/**
 * The one argument worth putting in the sentence, as the clause that
 * carries it. Precedence is explicit and ordered — a search tool given
 * both a query and a path is describing the query.
 */
function argumentClause(input: unknown): string | undefined {
  const args = asRecord(input);
  if (args === undefined) return undefined;

  const query =
    readString(args, "query") ??
    readString(args, "q") ??
    readString(args, "search_query") ??
    readString(args, "pattern") ??
    readString(args, "keywords");
  if (query !== undefined) {
    return `for "${truncate(query, MAX_PHRASE_ARGUMENT)}"`;
  }

  const url = readString(args, "url");
  if (url !== undefined) {
    const host = hostname(url);
    return host === undefined ? undefined : `on ${host}`;
  }

  const path =
    readString(args, "path") ??
    readString(args, "file_path") ??
    readString(args, "filename") ??
    readString(args, "file");
  if (path !== undefined) {
    return `— ${truncate(basename(path), MAX_PHRASE_ARGUMENT)}`;
  }

  const channel = readString(args, "channel");
  if (channel !== undefined) {
    const withHash = channel.startsWith("#") ? channel : `#${channel}`;
    return `in ${truncate(withHash, MAX_PHRASE_ARGUMENT)}`;
  }

  const repo = readString(args, "repo") ?? readString(args, "repository");
  if (repo !== undefined) {
    return `in ${truncate(repo, MAX_PHRASE_ARGUMENT)}`;
  }

  const command = readString(args, "command") ?? readString(args, "cmd");
  if (command !== undefined) {
    return `— ${truncate(command, MAX_PHRASE_ARGUMENT)}`;
  }

  return undefined;
}

function isWebSearch(identity: ToolIdentity): boolean {
  const hasSearchVerb =
    identity.words.includes("search") || identity.words.includes("browse");
  const hasWebObject =
    identity.words.includes("web") || identity.words.includes("internet");
  return hasSearchVerb && hasWebObject;
}

function objectPhrase(words: readonly string[]): string | undefined {
  if (words.length === 0) return undefined;
  const joined = words.join(" ");
  const lastWord = words[words.length - 1] ?? "";
  const isPlural = lastWord.endsWith("s") && !lastWord.endsWith("ss");
  if (isPlural) return joined;
  const startsWithVowel = /^[aeiou]/.test(joined);
  return `${startsWithVowel ? "an" : "a"} ${joined}`;
}

function buildClauseSuffix(
  clause: string | undefined,
  hasProvider: boolean,
): string {
  if (clause === undefined) return "";
  if (hasProvider && clause.startsWith("in ")) {
    return ` ${clause.slice("in ".length)}`;
  }
  return ` ${clause}`;
}

/**
 * What this tool call did, as a sentence — in the tense its status calls
 * for. Never contains the tool's identifier, its argument JSON, or an
 * internal id.
 */
export function describeToolCall(
  name: string,
  input: unknown,
  tense: Tense,
): string {
  const identity = resolveToolIdentity(name, input);
  const clause = argumentClause(input);

  if (isWebSearch(identity)) {
    const verb = tense === "past" ? "Searched" : "Searching";
    const target = clause ?? "";
    return `${verb} the web ${target}`.trim();
  }

  const verbWord = identity.words[0];
  const conjugation = verbWord === undefined ? undefined : VERBS[verbWord];
  const providerSuffix =
    identity.provider === undefined
      ? ""
      : ` in ${providerDisplayName(identity.provider)}`;

  if (conjugation === undefined) {
    const fallback = identity.words.map((word) => word).join(" ");
    const sentence = fallback === "" ? "Ran a step" : titleCase(fallback);
    return `${sentence}${providerSuffix}`;
  }

  const object = objectPhrase(identity.words.slice(1));
  const head =
    object === undefined
      ? conjugation[tense]
      : `${conjugation[tense]} ${object}`;
  // The provider suffix is itself an "in …" clause, so a clause that is
  // also locative ("in #general") drops its own preposition rather than
  // stuttering — "Posted a message in Slack #general", never "… in Slack
  // in #general".
  const clauseSuffix = buildClauseSuffix(clause, providerSuffix !== "");
  return `${head}${providerSuffix}${clauseSuffix}`;
}

/**
 * Pulls readable prose out of whatever a tool handed back. Tool results
 * arrive as a string, as MCP content blocks, or as an arbitrary object;
 * only the first two carry anything worth showing a person, and this
 * returns undefined rather than stringifying the third.
 */
export function plainTextOfOutput(output: unknown): string | undefined {
  if (typeof output === "string") {
    const trimmed = output.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (Array.isArray(output)) {
    const texts = output
      .map((entry) => plainTextOfOutput(entry))
      .filter((text): text is string => text !== undefined);
    return texts.length === 0 ? undefined : texts.join("\n");
  }
  const record = asRecord(output);
  if (record === undefined) return undefined;
  const nested = record.content;
  if (nested !== undefined) {
    const fromContent = plainTextOfOutput(nested);
    if (fromContent !== undefined) return fromContent;
  }
  return (
    readString(record, "text") ??
    readString(record, "message") ??
    readString(record, "error")
  );
}

/** How many things a result was, when it was a list of them. */
function countSummary(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  if (output.length === 0) return "Nothing found.";
  return output.length === 1 ? "1 result." : `${output.length} results.`;
}

/**
 * The detail a row opens onto: plain text, always. A failure keeps its
 * first line — the reason, said plainly — and never goes silent: a tool
 * that fails without saying why still says that much.
 */
export function summarizeToolOutput(
  status: ToolActivityStatus,
  output: unknown,
): string | undefined {
  const text = plainTextOfOutput(output);
  if (status === "failed") {
    if (text === undefined) return "No reason given.";
    const firstLine = text.split("\n")[0] ?? text;
    return truncate(firstLine, MAX_FAILURE_DETAIL);
  }
  if (status !== "success") return undefined;
  if (text !== undefined) return truncate(text, MAX_SUCCESS_DETAIL);
  return countSummary(output);
}

function rowStatus(part: ToolTracePart): ToolActivityStatus {
  if (part.status === "error") return "failed";
  if (part.status === "success") return "success";
  return part.status;
}

export function toToolActivityRow(
  part: ToolTracePart,
  key: string,
): ToolActivityRow {
  const status = rowStatus(part);
  const tense: Tense =
    status === "running" || status === "pending" ? "present" : "past";
  return {
    key,
    toolName: part.name,
    phrase: describeToolCall(part.name, part.input, tense),
    detail: summarizeToolOutput(status, part.output),
    status,
  };
}

export type ToolRoundSummary = {
  readonly label: string;
  readonly status: ToolActivityStatus;
  /** Whether the group shows its rows without being asked. A round that
   * contains a failure is one where the detail is the point. */
  readonly opensByDefault: boolean;
};

/**
 * The one line that stands in for a whole round of tool calls. While
 * something is still running the round speaks as that step ("Searching
 * the web for …") — the reader wants to know what is happening now, not
 * that five things happened. Once settled it counts, and says plainly if
 * any of them didn't work.
 */
export function describeToolRound(
  rows: readonly ToolActivityRow[],
): ToolRoundSummary {
  const active = rows.find(
    (row) => row.status === "running" || row.status === "pending",
  );
  if (active !== undefined) {
    return {
      label: active.phrase,
      status: active.status,
      opensByDefault: false,
    };
  }
  const failures = rows.filter((row) => row.status === "failed").length;
  const stepCount = `${rows.length} steps`;
  if (failures > 0) {
    return {
      label: `${stepCount}, ${failures} didn't work`,
      status: "failed",
      opensByDefault: true,
    };
  }
  return { label: stepCount, status: "success", opensByDefault: false };
}

export type TimelinePartGroup =
  | { readonly kind: "part"; readonly part: Part; readonly key: string }
  | {
      readonly kind: "tool-activity";
      readonly rows: readonly ToolActivityRow[];
      readonly key: string;
    };

/**
 * Folds a message's parts into render groups, coalescing every run of
 * consecutive tool calls into one. An agent that searches, reads four
 * files and edits two of them produced seven parts and one piece of news:
 * grouping is what keeps the reply visible above its own machinery.
 */
export function groupTimelineParts(
  parts: readonly Part[],
  keyPrefix: string,
): readonly TimelinePartGroup[] {
  const groups: TimelinePartGroup[] = [];
  let openRows: ToolActivityRow[] | undefined;
  let openKey = "";

  function closeOpenRun() {
    if (openRows === undefined) return;
    groups.push({ kind: "tool-activity", rows: openRows, key: openKey });
    openRows = undefined;
  }

  parts.forEach((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.kind !== "tool-trace") {
      closeOpenRun();
      groups.push({ kind: "part", part, key });
      return;
    }
    const row = toToolActivityRow(part, key);
    if (openRows === undefined) {
      openRows = [row];
      openKey = `${key}-tools`;
      return;
    }
    openRows.push(row);
  });

  closeOpenRun();
  return groups;
}
