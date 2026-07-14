import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB_SRC = join(import.meta.dir, "../../../apps/web/src");
const BROWSER_ENTRY = join(import.meta.dir, "browser.ts");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walkTsFiles(path));
      continue;
    }
    if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

const BROWSER_FROM_MARKERS = [
  'from "@workbench/agents/browser"',
  "from '@workbench/agents/browser'",
] as const;

function parseNamedImportBody(body: string): string[] {
  const names: string[] = [];
  for (const segment of body.split(",")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const withoutType = trimmed.replace(/^type\s+/, "");
    const name = withoutType.split(/\s+as\s+/)[0]?.trim();
    if (name && /^\w+$/.test(name)) names.push(name);
  }
  return names;
}

/** Named bindings imported from the browser entry across apps/web. */
function extractBrowserImportNames(source: string): string[] {
  const names: string[] = [];
  for (const marker of BROWSER_FROM_MARKERS) {
    let searchFrom = 0;
    while (true) {
      const fromIdx = source.indexOf(marker, searchFrom);
      if (fromIdx === -1) break;
      const closeBrace = source.lastIndexOf("}", fromIdx);
      if (closeBrace === -1) break;

      let pos = closeBrace - 1;
      let depth = 1;
      while (pos >= 0 && depth > 0) {
        const ch = source[pos];
        if (ch === "}") depth++;
        else if (ch === "{") depth--;
        pos--;
      }
      const openBrace = pos + 1;
      const prelude = source.slice(0, openBrace);
      const importIdx = prelude.lastIndexOf("import");
      if (importIdx === -1) {
        searchFrom = fromIdx + marker.length;
        continue;
      }
      const header = source.slice(importIdx, openBrace + 1);
      if (!/import\s+(?:type\s+)?\{/.test(header)) {
        searchFrom = fromIdx + marker.length;
        continue;
      }

      names.push(...parseNamedImportBody(source.slice(openBrace + 1, closeBrace)));
      searchFrom = fromIdx + marker.length;
    }
  }
  return names;
}

function collectWebBrowserImports(): Map<string, Set<string>> {
  const bySymbol = new Map<string, Set<string>>();
  for (const file of walkTsFiles(WEB_SRC)) {
    const source = readFileSync(file, "utf8");
    for (const name of extractBrowserImportNames(source)) {
      const files = bySymbol.get(name) ?? new Set<string>();
      files.add(file);
      bySymbol.set(name, files);
    }
  }
  return bySymbol;
}

/** Symbols re-exported from packages/agents/src/browser.ts (values + types). */
function collectBrowserEntryExportNames(): Set<string> {
  const source = readFileSync(BROWSER_ENTRY, "utf8");
  const names = new Set<string>();

  const exportBlocks = source.matchAll(/export\s*\{([\s\S]*?)\}(?:\s*from\s*["'][^"']+["'])?/g);
  for (const block of exportBlocks) {
    for (const segment of block[1].split(",")) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      const withoutType = trimmed.replace(/^type\s+/, "");
      const name = withoutType.split(/\s+as\s+/)[0]?.trim();
      if (name && /^\w+$/.test(name)) names.add(name);
    }
  }

  for (const decl of source.matchAll(
    /export\s+(?:const|function|class|type|interface)\s+(\w+)/g,
  )) {
    names.add(decl[1]);
  }

  return names;
}

describe("browser entrypoint public exports", () => {
  test("every apps/web import from @workbench/agents/browser is re-exported from browser.ts", () => {
    const webImports = collectWebBrowserImports();
    const browserExports = collectBrowserEntryExportNames();
    const missing: string[] = [];

    for (const [symbol, files] of webImports) {
      if (!browserExports.has(symbol)) {
        const sample = [...files].slice(0, 3).join(", ");
        missing.push(`${symbol} (e.g. ${sample})`);
      }
    }

    expect(missing).toEqual([]);
  });
});