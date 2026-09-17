// check:owned-tables-fk — CL-8210's ruling: every custom (non-Interchange)
// Postgres table Workbench owns lives on its own named `pgSchema(...)`,
// never `public`, and every `tenant_id`/`principal_id` column on it is a
// real foreign key (a drizzle `.references(...)` call) back to
// Interchange's tenant/principal tables with `ON DELETE CASCADE`. This
// check enforces the mechanical half of that ruling over every
// `pgTable(...)`/`<schema>.table(...)` declaration outside `vendor/` —
// it cannot verify the FK target is actually Interchange's table, or that
// `onDelete: "cascade"` is set, only that `.references(` appears at all;
// a reviewer still reads the diff for those.
//
// A bare `pgTable("tenant", { id: text("id").primaryKey() })` — the
// "declared, never migrated" stub every FK-carrying package uses to name
// Interchange's own table for the FK to point at (see
// packages/notify/src/schema.ts's `hostTenant`/`hostPrincipal`) — is not a
// table this package owns, so it is exempted by HOST_STUB_TABLES below
// rather than by a generic "few columns" heuristic.
import { Glob } from "bun";
import path from "node:path";
import { emptyReport, reportAndExit, rootFromArgs, type CheckReport } from "./lib/repo";

const SCAN_DIRS = ["apps", "packages", "workflows"];

// Interchange's own control-plane tables, re-declared locally (never
// migrated) purely to carry a drizzle `.references()` FK target. These
// names are exempt from both rules: they're not owned tables.
const HOST_STUB_TABLES = new Set(["tenant", "principal"]);

// Pre-existing tenant_id/principal_id debt this check does not (yet) fail
// on. `@corbits/chat` is owned by another workstream — its schema already
// lives on its own `chat` pgSchema (satisfying the schema half of
// CL-8210) but its tenant_id/principal_id columns predate the FK ruling
// and are out of scope for CL-8210's PR, which is explicitly barred from
// touching packages/chat/**. Tracked as its own follow-up rather than
// silently exempted forever: a shrinking ledger, not a blanket allowlist.
const FK_DEBT_FILES = new Set(["packages/chat/src/schema.ts"]);

const TABLE_CALL_PATTERN =
  /(?:(\b[A-Za-z_][A-Za-z0-9_]*)\.table|(\bpgTable))\(\s*"([a-zA-Z0-9_]+)"/g;

export interface TableDeclaration {
  readonly relPath: string;
  readonly tableName: string;
  readonly hasOwnSchema: boolean;
  readonly body: string;
}

/** Finds the matching closing brace for the `{` at `openIndex` in `text`. */
function matchBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits a `{...}` object body into its top-level `key: value` entries. */
function splitTopLevelEntries(body: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      entries.push(body.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(body.slice(start));
  return entries.map((e) => e.trim()).filter((e) => e.length > 0);
}

export function findTableDeclarations(relPath: string, contents: string): TableDeclaration[] {
  const declarations: TableDeclaration[] = [];
  for (const match of contents.matchAll(TABLE_CALL_PATTERN)) {
    const schemaVar = match[1];
    const tableName = match[3] ?? "";
    const callEnd = (match.index ?? 0) + match[0].length;
    const braceStart = contents.indexOf("{", callEnd);
    if (braceStart === -1) continue;
    // A non-object second argument (e.g. a bare `pgTable("x", columns)`
    // referencing a variable) has no literal body to inspect; skip it —
    // nothing in this repo declares a table that way today.
    const betweenCommaAndBrace = contents.slice(callEnd, braceStart).trim();
    if (betweenCommaAndBrace !== "," && betweenCommaAndBrace !== "") continue;
    const braceEnd = matchBrace(contents, braceStart);
    if (braceEnd === -1) continue;
    declarations.push({
      relPath,
      tableName,
      hasOwnSchema: schemaVar !== undefined,
      body: contents.slice(braceStart + 1, braceEnd),
    });
  }
  return declarations;
}

const ID_COLUMN_PATTERN = /^(?:(\w+):\s*)?text\(\s*"(tenant_id|principal_id)"\s*\)/;

export function auditOwnedTablesFk(
  files: readonly { relPath: string; contents: string }[],
): CheckReport {
  const report = emptyReport();
  for (const { relPath, contents } of files) {
    if (FK_DEBT_FILES.has(relPath)) {
      report.notes.push(`${relPath}: skipped — tracked FK debt, see FK_DEBT_FILES`);
      continue;
    }
    const declarations = findTableDeclarations(relPath, contents);
    for (const decl of declarations) {
      if (HOST_STUB_TABLES.has(decl.tableName)) continue;

      if (!decl.hasOwnSchema) {
        report.violations.push(
          `${relPath}: table "${decl.tableName}" is declared with a bare pgTable(...) ` +
            `call, not on a named pgSchema(...) — every table Workbench owns must live ` +
            `on its own schema, never public (CL-8210).`,
        );
      }

      for (const entry of splitTopLevelEntries(decl.body)) {
        const idMatch = entry.match(ID_COLUMN_PATTERN);
        if (idMatch === undefined || idMatch === null) continue;
        if (!entry.includes(".references(")) {
          report.violations.push(
            `${relPath}: table "${decl.tableName}" column "${idMatch[2]}" has no ` +
              `.references(...) — every tenant_id/principal_id column must be a real ` +
              `foreign key to Interchange's tenant/principal table, ON DELETE CASCADE ` +
              `(CL-8210).`,
          );
        }
      }
    }
  }
  return report;
}

async function scanFiles(root: string, dirs: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const dir of dirs) {
    const glob = new Glob(`${dir}/**/*.{ts,tsx}`);
    for await (const file of glob.scan({ cwd: root, dot: false })) {
      if (file.includes("node_modules/")) continue;
      if (file.includes("/dist/") || file.startsWith("dist/")) continue;
      if (file.includes("/vendor/") || file.startsWith("vendor/")) continue;
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      files.push(file);
    }
  }
  return files;
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const root = rootFromArgs(args);
  const relPaths = await scanFiles(root, SCAN_DIRS);
  const files = await Promise.all(
    relPaths.map(async (relPath) => ({
      relPath,
      contents: await Bun.file(path.join(root, relPath)).text(),
    })),
  );
  const report = auditOwnedTablesFk(files);
  report.notes.push(`scanned ${files.length} file(s) under ${SCAN_DIRS.join(", ")}`);
  reportAndExit("check:owned-tables-fk", report);
}

if (import.meta.main) await main();
