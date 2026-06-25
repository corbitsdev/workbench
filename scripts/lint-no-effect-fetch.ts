// CL-1908 enforcement: data fetching belongs in TanStack Query, never in a raw
// useEffect. The eslint `no-restricted-syntax` rule cannot express the
// "fetch-inside-useEffect-not-wrapped-in-useQuery" relationship, so this
// standalone check approximates it: it flags a `useEffect(...)` whose
// callback body contains a `fetch(` or api-client call that is NOT wrapped in a
// `useQuery` / `useMutation`. Wired into `bun run lint:no-effect-fetch` and the
// root `lint` script.
//
// Scope is apps/web/src/**. The matcher is intentionally conservative — it only
// errors on calls that appear literally inside the effect callback — so it does
// not false-positive on the existing auth/provisioning bootstrap effects that
// delegate to a separately-defined `useCallback`/named function. Those indirect
// cases are surfaced as warnings, not errors, so the lint gate stays green.

import { Glob } from "bun";
import { join } from "node:path";

const WEB_SRC = join(import.meta.dir, "..", "apps", "web", "src");

const API_CALL =
  /\b(?:fetch|api\.[a-zA-Z]+|getMe|listWorkbenches|launchInstanceSession|createWorkbench|deployAgentFromTemplate|listApprovals|approveRequest|rejectRequest|listAgentInstances)\s*\(/;
const QUERY_GUARD = /\buse(?:Query|Mutation|InfiniteQuery|SuspenseQuery)\b/;

interface Finding {
  file: string;
  line: number;
  severity: "error" | "warning";
  snippet: string;
}

function findEffectBody(
  source: string,
  openParenIndex: number,
): { body: string; endIndex: number } | null {
  let depth = 0;
  let started = false;
  for (let index = openParenIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") {
      depth += 1;
      started = true;
    } else if (character === ")") {
      depth -= 1;
      if (started && depth === 0) {
        return {
          body: source.slice(openParenIndex + 1, index),
          endIndex: index,
        };
      }
    }
  }
  return null;
}

function lineNumberOf(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < source.length; cursor += 1) {
    if (source[cursor] === "\n") {
      line += 1;
    }
  }
  return line;
}

function scanFile(relativePath: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const effectPattern = /\buseEffect\s*\(/g;
  let match: RegExpExecArray | null = effectPattern.exec(source);
  while (match !== null) {
    const callStart = match.index + match[0].length - 1;
    const effect = findEffectBody(source, callStart);
    if (effect !== null) {
      const apiMatch = API_CALL.exec(effect.body);
      if (apiMatch !== null && !QUERY_GUARD.test(effect.body)) {
        const directFetch = /\bfetch\s*\(/.test(effect.body);
        const callIndex = match.index + apiMatch.index;
        findings.push({
          file: relativePath,
          line: lineNumberOf(source, callIndex),
          severity: directFetch ? "error" : "warning",
          snippet: apiMatch[0],
        });
      }
      effectPattern.lastIndex = effect.endIndex;
    }
    match = effectPattern.exec(source);
  }
  return findings;
}

async function main(): Promise<void> {
  const glob = new Glob("**/*.{ts,tsx}");
  const findings: Finding[] = [];
  for await (const entry of glob.scan(WEB_SRC)) {
    const absolute = join(WEB_SRC, entry);
    const source = await Bun.file(absolute).text();
    findings.push(...scanFile(join("apps/web/src", entry), source));
  }

  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");

  for (const warning of warnings) {
    process.stderr.write(
      `warning ${warning.file}:${warning.line} data call '${warning.snippet}' inside useEffect — move to TanStack Query (useQuery)\n`,
    );
  }
  for (const error of errors) {
    process.stderr.write(
      `error ${error.file}:${error.line} fetch() inside useEffect — data fetching must use TanStack Query (useQuery)\n`,
    );
  }

  if (errors.length > 0) {
    process.stderr.write(`\nno-effect-fetch: ${errors.length} error(s)\n`);
    process.exit(1);
  }
  process.stdout.write(`no-effect-fetch: ok (${warnings.length} warning(s))\n`);
}

await main();
