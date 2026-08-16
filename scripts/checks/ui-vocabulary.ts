// check:ui-vocabulary — internal implementation vocabulary must never
// leak into a string a user reads. "Hub", "bench", "rail", "principal",
// "tenant", "instance", "deploy(ed)", "definition", "DATABASE_URL", and
// "asset" are all names for things from the operator/platform side of
// the fence; the product word for a workspace is "workbench" and its
// switching control is the "switcher". "Channel" and "space(s)" are
// banned too — the shell is chat-first now (CL-6081): every conversation
// a person starts reads as a "chat", never a "space" or a "channel"
// (both stay legal only as the underlying platform/API vocabulary:
// `kind: "channel"`, route paths, event names, and other non-prose
// identifiers, none of which this check's prose filter treats as copy
// anyway) — see docs/GLOSSARY.md and the CL-6016, CL-6071, and CL-6081
// copy sweeps this check guards.
//
// This scans string and template literals in apps/web/src and
// packages/chat-ui/src (excluding *.test.ts(x)) for the banned terms.
// It only flags a literal that reads as natural-language copy — one
// containing a space — so kebab-case CSS class names, API scope
// literals like "personal" | "bench", and query-key segments never
// trip it; those aren't copy a user reads. Comments, import/export
// specifiers, and console/logger calls are stripped before scanning,
// since logs and code comments are for engineers, not users. A small
// inline ALLOWLIST covers real exceptions — "Workbench" the product
// name is never a false match (the word-boundary regex won't match
// "bench" inside "workbench"), and technical Settings copy that
// legitimately says "webhook" doesn't contain any banned term either;
// the allowlist exists for the rare case both are true at once.
import { Glob } from "bun";
import path from "node:path";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

const SCAN_DIRS = [
  "apps/web/src",
  "packages/chat-ui/src",
  "packages/tasks-ui/src",
];

const BANNED_TERMS: readonly { name: string; pattern: RegExp }[] = [
  { name: "hub", pattern: /\bhub\b/i },
  { name: "bench", pattern: /\bbench(es)?\b/i },
  { name: "rail", pattern: /\brail\b/i },
  { name: "principal", pattern: /\bprincipals?\b/i },
  { name: "tenant", pattern: /\btenants?\b/i },
  { name: "instance", pattern: /\binstances?\b/i },
  { name: "deploy", pattern: /\bdeploy(ed|ing|s|ment)?\b/i },
  { name: "definition", pattern: /\bdefinitions?\b/i },
  { name: "DATABASE_URL", pattern: /\bDATABASE_URL\b/ },
  { name: "asset", pattern: /\bassets?\b/i },
  { name: "channel", pattern: /\bchannels?\b/i },
  { name: "space", pattern: /\bspaces?\b/i },
];

/**
 * The nav band renamed "Channels" → "Spaces" (CL-6054), then "Spaces" →
 * "Chats" (CL-6081): the band you direct work from, not the word for a
 * single conversation. A single-word label value like `"Channels"` or
 * `"Spaces"` has no whitespace, so `isProseLiteral`'s space-heuristic
 * never even hands it to the `BANNED_TERMS` scan below — this pattern is
 * the dedicated regression guard for exactly that gap, matching the
 * shape a reintroduced label would take for either retired name: a
 * `label`/`title` object property (`title: "Spaces"`), the same as a
 * JSX attribute (`title="Channels"`), or an `aria-label` attribute set
 * to precisely one of those two words — so it never trips on legitimate
 * copy that happens to contain one: prose like "Channels and running
 * routines…" (not a bare label value), `channelsSectionLabel: "Channels"`
 * (chat-ui's pinned-vs-chat kind label, a different concept from the nav
 * band), or a command palette `heading: "Channels"` (groups search
 * results by entity kind, same pattern as its `heading: "Routines"`
 * sibling). Those all stay legal; only the band label itself is banned.
 */
const BAND_LABEL_PATTERN =
  /\b(?:label|title)\s*[:=]\s*"(?:Channels|Spaces)"|aria-label\s*=\s*"(?:Channels|Spaces)"/g;

/**
 * Exact strings that legitimately contain a banned term as UI copy.
 * Each entry names the file it's allowed in, so a copy of the same
 * phrase landing in a different file still fails — an allowlist entry
 * is a ruling about one spot, never a blanket exemption for a phrase.
 */
const ALLOWLIST: readonly { relPath: string; text: string }[] = [];

/** Strips comments and console/logger calls so log lines and
 * documentation never count as user-facing copy. Deliberately simple —
 * this is not a JS parser, just enough to keep the scan honest for the
 * patterns this codebase actually uses. */
function blank(match: string): string {
  return match.replace(/[^\n]/g, " ");
}

export function stripNonUserFacing(source: string): string {
  let stripped = source.replace(/\/\*[\s\S]*?\*\//g, blank);
  stripped = stripped.replace(
    /(^|[^:])(\/\/.*)$/gm,
    (_match, prefix: string, comment: string) => prefix + blank(comment),
  );
  stripped = stripped.replace(
    /\b(?:console|log|logger)\.\w+\([\s\S]*?\);/g,
    blank,
  );
  return stripped;
}

// `'` and `"` literals can never contain a literal newline in valid JS —
// excluding \n from their body keeps a stray apostrophe in JSX prose
// (e.g. "routine's") from being misread as an opening quote that then
// runs on and swallows everything up to some unrelated quote far below.
// Only a backtick template literal is allowed to span lines.
const STRING_LITERAL_PATTERN =
  /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

// Allows a trailing decimal (Tailwind's fractional spacing utilities, e.g.
// "space-y-1.5", "gap-x-2.5") and an arbitrary-value suffix in brackets
// (e.g. "text-[var(--ui-fg-muted)]") alongside the plain kebab-case shape —
// still never matches real prose, which has no reason to end a word in
// digits or bracketed CSS syntax.
const KEBAB_TOKEN = /^[a-z][a-z0-9-]*(?:\.\d+)?(?:\[[^\s"'`]*\])?$/;
const QUOTED_UNION = /^'[\w-]*'(\s*\|\s*'[\w-]*')*$/;

/** Blanks out `${...}` template-literal interpolations, keeping
 * everything outside them intact. A backtick literal like `` `delivers
 * to ${channel.title}.` `` reads as prose to a user ("delivers to
 * Launch planning.") — the identifier `channel.title` inside the
 * expression is code the user never sees, so it must never trip a
 * banned-term match on its own. Non-greedy so nested braces in a rare
 * object-literal expression don't swallow past the first `}`. */
function stripInterpolations(inner: string): string {
  return inner.replace(/\$\{[^}]*\}/g, blank);
}

/** A literal counts as natural-language copy only when it contains a
 * space and isn't one of the handful of non-prose shapes that also
 * contain spaces: a CSS class list (space-separated kebab-case
 * tokens), an arktype/TS quoted-union type literal ('personal' |
 * 'bench'), or a URL/API path. None of those are copy a user reads. */
function isProseLiteral(literal: string): boolean {
  const inner = literal.slice(1, -1);
  if (!/\s/.test(inner)) return false;
  if (QUOTED_UNION.test(inner.trim())) return false;
  if (inner.trim().startsWith("/")) return false;
  const tokens = inner.trim().split(/\s+/);
  if (tokens.length > 1 && tokens.every((token) => KEBAB_TOKEN.test(token))) {
    return false;
  }
  return true;
}

export interface ScannedFile {
  relPath: string;
  contents: string;
}

export interface Violation {
  relPath: string;
  line: number;
  term: string;
  literal: string;
}

export function findViolations(files: readonly ScannedFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const { relPath, contents } of files) {
    const scanned = stripNonUserFacing(contents);
    const lines = contents.split("\n");
    for (const match of scanned.matchAll(STRING_LITERAL_PATTERN)) {
      const literal = match[0];
      if (!isProseLiteral(literal)) continue;
      const inner = literal.slice(1, -1);
      const testable = literal.startsWith("`")
        ? stripInterpolations(inner)
        : inner;
      const hit = BANNED_TERMS.find(({ pattern }) => pattern.test(testable));
      if (hit === undefined) continue;
      if (
        ALLOWLIST.some(
          (entry) => entry.relPath === relPath && entry.text === inner,
        )
      ) {
        continue;
      }
      const upToMatch = scanned.slice(0, match.index);
      const line = upToMatch.split("\n").length;
      violations.push({
        relPath,
        line,
        term: hit.name,
        literal: lines[line - 1] ?? literal,
      });
    }
    for (const match of scanned.matchAll(BAND_LABEL_PATTERN)) {
      const upToMatch = scanned.slice(0, match.index);
      const line = upToMatch.split("\n").length;
      violations.push({
        relPath,
        line,
        term: "Channels/Spaces (nav band label)",
        literal: lines[line - 1] ?? match[0],
      });
    }
  }
  return violations;
}

export function auditUiVocabulary(files: readonly ScannedFile[]): CheckReport {
  const report = emptyReport();
  for (const violation of findViolations(files)) {
    report.violations.push(
      `${violation.relPath}:${violation.line}: contains banned term ` +
        `"${violation.term}" in a user-facing string — ${violation.literal.trim()}`,
    );
  }
  return report;
}

async function scanFiles(
  root: string,
  dirs: readonly string[],
): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  for (const dir of dirs) {
    const glob = new Glob("**/*.{ts,tsx}");
    for await (const file of glob.scan({ cwd: path.join(root, dir) })) {
      if (file.includes("node_modules/")) continue;
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const relPath = path.join(dir, file);
      files.push({
        relPath,
        contents: await Bun.file(path.join(root, relPath)).text(),
      });
    }
  }
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function main(): Promise<void> {
  const root = rootFromArgs(Bun.argv.slice(2));
  const files = await scanFiles(root, SCAN_DIRS);
  const report = auditUiVocabulary(files);
  report.notes.push(
    `scanned ${files.length} file(s) under ${SCAN_DIRS.join(", ")}`,
  );
  reportAndExit("check:ui-vocabulary", report);
}

if (import.meta.main) await main();
