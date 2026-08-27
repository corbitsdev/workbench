// Turning a turn's tool calls into something a person can read.
//
// The wire carries a tool call as an identifier plus an argument bag plus
// whatever the tool handed back (`ToolTracePart` in `@corbits/chat/parts`,
// assembled by the chat orchestrator from `inferenceDoneBlocks` /
// `toolDoneResult`). None of those three is fit to show anyone: the
// identifier is a symbol (`slack__post_message`, or an Interchange qualified
// id `@scope/package/export:tool`), the arguments are JSON, and the result
// is usually a content-block array. This module is the one place that
// translates all three into plain sentences — "Posted a message in Slack",
// "Searched memory for "outbound"" — so no surface downstream ever has to
// reach for `JSON.stringify` to say what happened. The phrase uses the
// segment after the last colon (the end tool name); a leftover path is a
// provider only when it maps onto a known brand, never `@corbits` or a
// package stem like `memory-tools`.
//
// Both the live strip (`turn-activity.tsx`, mid-turn) and the persisted
// transcript (`timeline.tsx`) render through here, which is why a phrase
// comes in two tenses: the same call reads "Searching the web for
// "pricing"" while it runs and "Searched the web for "pricing"" once it
// settles.

import type { Part, ToolTracePart } from "@corbits/chat/parts";

export type ToolActivityStatus = "pending" | "running" | "success" | "failed";

export type ToolActivityGlyph =
  "search" | "list" | "ask" | "memory" | "agents" | "write" | "generic";

/** One tool call, ready to render: no identifiers, no JSON, no tense
 * mismatch with its own status. */
export type ToolActivityRow = {
  readonly key: string;
  /** The end tool name (`memory_search`), used as the chip's hover title. */
  readonly toolName: string;
  /** Action glyph for a local tool. Known brand providers use a tile instead. */
  readonly glyph: ToolActivityGlyph;
  /** The provider namespace a call belongs to, e.g. `"slack"` — undefined
   * for a bare local tool. Feeds the chip's leading brand tile when known. */
  readonly provider: string | undefined;
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
const MAX_SHORT_FIELD = 240;

type Tense = "past" | "present";

type Conjugation = { readonly past: string; readonly present: string };

/** The verbs tool names actually start (or end) with, in the two forms a
 * transcript needs. Irregulars are why this is a table and not a suffix rule. */
const VERBS: Record<string, Conjugation> = {
  add: { past: "Added", present: "Adding" },
  archive: { past: "Archived", present: "Archiving" },
  ask: { past: "Asked", present: "Asking" },
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

export type ProviderTile = {
  readonly initials: string;
  readonly color: string;
};

/** Brand mark for the chip's leading tile — two letters and the provider's
 * own color, the way the mock's `[Li #5E6AD2]` / `[GH #24292f]` read. Only
 * providers a person would recognise on sight get a fixed brand color;
 * anything else is not a brand — the chip uses an action glyph. */
const PROVIDER_TILES: Record<string, ProviderTile> = {
  github: { initials: "GH", color: "#24292f" },
  gitlab: { initials: "GL", color: "#fc6d26" },
  linear: { initials: "Li", color: "#5e6ad2" },
  notion: { initials: "No", color: "#000000" },
  postgres: { initials: "Pg", color: "#336791" },
  slack: { initials: "Sl", color: "#4a154b" },
};

/** Path segments that look like a namespace but are not a brand provider. */
const NOT_PROVIDERS = new Set([
  "memory",
  "ad",
  "ask-user",
  "corbits",
  "@corbits",
]);

/** Brand mark for a known provider. Unknown leftovers are not brands —
 * the chip uses an action glyph instead of inventing initials. */
export function providerTile(provider: string): ProviderTile | undefined {
  return PROVIDER_TILES[provider.toLowerCase()];
}

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

export type ToolIdentity = {
  readonly provider: string | undefined;
  readonly words: readonly string[];
  readonly toolName: string;
};

function splitToolWords(name: string): readonly string[] {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced
    .split(/[_\-.\s]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word !== "");
}

function packageStem(segment: string): string {
  const id = segment.replace(/^@/, "").toLowerCase();
  return id.endsWith("-tools") ? id.slice(0, -"-tools".length) : id;
}

function knownBrandId(candidate: string): string | undefined {
  const stemmed = packageStem(candidate);
  if (stemmed === "" || NOT_PROVIDERS.has(stemmed)) return undefined;
  if (
    PROVIDER_NAMES[stemmed] !== undefined ||
    PROVIDER_TILES[stemmed] !== undefined
  ) {
    return stemmed;
  }
  return undefined;
}

function providerFromLeftover(
  leftover: string | undefined,
): string | undefined {
  if (leftover === undefined || leftover === "") return undefined;
  const interchange = leftover.includes("/") || leftover.startsWith("@");
  if (interchange) {
    const segments = leftover.split("/").filter((segment) => segment !== "");
    for (const segment of segments) {
      const known = knownBrandId(segment);
      if (known !== undefined) return known;
    }
    return undefined;
  }
  const known = knownBrandId(leftover);
  if (known !== undefined) return known;
  return undefined;
}

function splitQualifiedName(name: string): {
  leftover: string | undefined;
  toolName: string;
} {
  const colon = name.lastIndexOf(":");
  if (colon !== -1) {
    return {
      leftover: name.slice(0, colon) || undefined,
      toolName: name.slice(colon + 1),
    };
  }
  const namespaced = name.split("__");
  if (namespaced.length > 1 && namespaced[0] !== undefined) {
    return {
      leftover: namespaced[0],
      toolName: namespaced.slice(1).join("_"),
    };
  }
  const dotted = name.split(".");
  if (dotted.length > 1 && dotted[0] !== undefined) {
    return {
      leftover: dotted[0],
      toolName: dotted.slice(1).join("_"),
    };
  }
  return { leftover: undefined, toolName: name };
}

/**
 * Splits a tool identifier into the provider it belongs to and the words
 * describing what it does.
 *
 * `mcp_read`/`mcp_call` are the generic MCP dispatch tools
 * (`packages/mcp-tools/src/tool.ts`): every downstream call arrives under
 * one of those two names, with the tool it actually invoked sitting in its
 * `{server, tool}` arguments — so those are read first, or a whole
 * conversation's worth of calls would all read alike.
 *
 * Interchange qualified ids (`@scope/package/export:tool`) take the
 * segment after the last `:`. A leftover path is a provider only when a
 * segment or `-tools` stem is a known brand; `memory`, `ad`, and
 * `ask-user` never are.
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
      return {
        provider: providerFromLeftover(server) ?? server,
        words: splitToolWords(tool),
        toolName: tool,
      };
    }
  }
  const split = splitQualifiedName(name);
  return {
    provider: providerFromLeftover(split.leftover),
    words: splitToolWords(split.toolName),
    toolName: split.toolName,
  };
}

export function toolActivityGlyph(words: readonly string[]): ToolActivityGlyph {
  const has = (candidates: readonly string[]) =>
    words.some((word) => candidates.includes(word));
  if (has(["search", "find", "query", "grep", "glob"])) return "search";
  if (has(["list"])) return "list";
  if (has(["ask"])) return "ask";
  if (has(["memory"])) return "memory";
  if (has(["agent", "agents"])) return "agents";
  if (has(["write", "edit", "create", "add"])) return "write";
  return "generic";
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

function pickVerb(words: readonly string[]): {
  verb: string | undefined;
  objectWords: readonly string[];
} {
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  if (first !== undefined && VERBS[first] !== undefined) {
    return { verb: first, objectWords: words.slice(1) };
  }
  if (last !== undefined && VERBS[last] !== undefined) {
    return { verb: last, objectWords: words.slice(0, -1) };
  }
  return { verb: undefined, objectWords: words };
}

function isPluralWord(word: string): boolean {
  return word.endsWith("s") && !word.endsWith("ss");
}

function pluralize(word: string): string {
  if (isPluralWord(word)) return word;
  if (word.length > 1 && word.endsWith("y")) {
    const beforeY = word.charAt(word.length - 2);
    if (!"aeiou".includes(beforeY)) return `${word.slice(0, -1)}ies`;
  }
  return `${word}s`;
}

function objectPhrase(
  words: readonly string[],
  verb: string | undefined,
): string | undefined {
  if (words.length === 0) return undefined;
  const lastWord = words[words.length - 1] ?? "";
  const rendered =
    verb === "list" && !isPluralWord(lastWord)
      ? [...words.slice(0, -1), pluralize(lastWord)]
      : words;
  const joined = rendered.join(" ");
  const renderedLast = rendered[rendered.length - 1] ?? "";
  if (isPluralWord(renderedLast)) return joined;
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

function domainHead(
  words: readonly string[],
  verb: string,
  tense: Tense,
): string | undefined {
  const has = (word: string) => words.includes(word);
  const conjugation = VERBS[verb];
  if (conjugation === undefined) return undefined;
  if (verb === "search" && (has("web") || has("internet"))) {
    return tense === "past" ? "Searched the web" : "Searching the web";
  }
  if (verb === "search" && has("memory")) {
    return tense === "past" ? "Searched memory" : "Searching memory";
  }
  if (verb === "list" && has("memory")) {
    return tense === "past" ? "Listed memories" : "Listing memories";
  }
  if ((verb === "add" || verb === "create") && has("memory")) {
    return tense === "past" ? "Saved a memory" : "Saving a memory";
  }
  if (verb === "ask" && has("user")) {
    return tense === "past" ? "Asked a question" : "Asking a question";
  }
  return undefined;
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
  const picked = pickVerb(identity.words);
  const providerSuffix =
    identity.provider === undefined
      ? ""
      : ` in ${providerDisplayName(identity.provider)}`;

  if (picked.verb !== undefined) {
    const domain = domainHead(identity.words, picked.verb, tense);
    if (domain !== undefined) {
      return `${domain}${buildClauseSuffix(clause, false)}`;
    }
    const conjugation = VERBS[picked.verb];
    if (conjugation !== undefined) {
      const object = objectPhrase(picked.objectWords, picked.verb);
      const head =
        object === undefined
          ? conjugation[tense]
          : `${conjugation[tense]} ${object}`;
      const clauseSuffix = buildClauseSuffix(clause, providerSuffix !== "");
      return `${head}${providerSuffix}${clauseSuffix}`;
    }
  }

  const fallback = identity.words.join(" ");
  const sentence = fallback === "" ? "Ran a step" : titleCase(fallback);
  return `${sentence}${providerSuffix}`;
}

function decodeOutput(output: unknown): unknown {
  if (typeof output !== "string") return output;
  const trimmed = output.trim();
  if (trimmed === "") return output;
  try {
    return JSON.parse(trimmed);
  } catch {
    return output;
  }
}

/**
 * Pulls readable prose out of whatever a tool handed back. Tool results
 * arrive as a string, as MCP content blocks, or as an arbitrary object;
 * only the first two carry anything worth showing a person, and this
 * returns undefined rather than stringifying the third.
 */
export function plainTextOfOutput(output: unknown): string | undefined {
  const decoded = decodeOutput(output);
  if (typeof decoded === "string") {
    const trimmed = decoded.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (Array.isArray(decoded)) {
    const texts = decoded
      .map((entry) => plainTextOfOutput(entry))
      .filter((text): text is string => text !== undefined);
    return texts.length === 0 ? undefined : texts.join("\n");
  }
  const record = asRecord(decoded);
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

function shortField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = readString(record, key);
  if (value === undefined) return undefined;
  if (value.length > MAX_SHORT_FIELD) return truncate(value, MAX_SHORT_FIELD);
  return value;
}

/** How many things a result was, when it was a list of them. */
function countSummary(output: unknown): string | undefined {
  if (Array.isArray(output)) {
    if (output.length === 0) return "Nothing found.";
    return output.length === 1 ? "1 result." : `${output.length} results.`;
  }
  const record = asRecord(output);
  const items = record?.items;
  if (Array.isArray(items)) return countSummary(items);
  return undefined;
}

function looksLikeContentBlocks(output: unknown): boolean {
  if (!Array.isArray(output) || output.length === 0) return false;
  return output.some((entry) => {
    const record = asRecord(entry);
    return record !== undefined && typeof record.type === "string";
  });
}

/**
 * The detail a row opens onto: plain text, always. A failure keeps its
 * first line — the reason, said plainly — and never goes silent: a tool
 * that fails without saying why still says that much.
 */
export function summarizeToolOutput(
  status: ToolActivityStatus,
  output: unknown,
  toolName?: string,
): string | undefined {
  if (toolName === "ask_user" && status !== "failed") return undefined;

  const decoded = decodeOutput(output);

  if (status === "failed") {
    const text = plainTextOfOutput(decoded);
    if (text === undefined) return "No reason given.";
    const firstLine = text.split("\n")[0] ?? text;
    return truncate(firstLine, MAX_FAILURE_DETAIL);
  }
  if (status !== "success") return undefined;

  if (!looksLikeContentBlocks(decoded)) {
    const counted = countSummary(decoded);
    if (counted !== undefined) return counted;
  }

  const record = asRecord(decoded);
  if (record !== undefined && !("content" in record)) {
    const field = shortField(record, "text") ?? shortField(record, "message");
    if (field !== undefined) return field;
    if (countSummary(decoded) === undefined) return undefined;
  }

  const text = plainTextOfOutput(decoded);
  if (text === undefined) return countSummary(decoded);
  const nested = decodeOutput(text);
  if (typeof nested === "string") return truncate(nested, MAX_SUCCESS_DETAIL);
  if (!looksLikeContentBlocks(nested)) {
    const counted = countSummary(nested);
    if (counted !== undefined) return counted;
  }
  const nestedRecord = asRecord(nested);
  if (nestedRecord !== undefined) {
    return (
      shortField(nestedRecord, "text") ?? shortField(nestedRecord, "message")
    );
  }
  return undefined;
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
  const identity = resolveToolIdentity(part.name, part.input);
  return {
    key,
    toolName: identity.toolName,
    glyph: toolActivityGlyph(identity.words),
    provider: identity.provider,
    phrase: describeToolCall(part.name, part.input, tense),
    detail: summarizeToolOutput(status, part.output, identity.toolName),
    status,
  };
}

export type TimelinePartGroup =
  | { readonly kind: "part"; readonly part: Part; readonly key: string }
  | {
      readonly kind: "tool-activity";
      readonly rows: readonly ToolActivityRow[];
      readonly key: string;
    };

/**
 * Splits a message's parts into render groups, clustering every run of
 * consecutive tool calls together. The cluster renders as a stack of
 * chips, one per call — never folded into a summary line — so this is
 * purely about keeping tool calls next to each other in the flow, not
 * about hiding them.
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
