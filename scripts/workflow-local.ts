/**
 * LOCAL proof for the DETERMINISTIC last30days-research WORKFLOW (CL-2503).
 *
 * Mirrors scripts/larry-local.ts, but instead of a single tool-calling agent it
 * runs the workflow's REAL logic end-to-end out-of-process: the real source tools
 * (live APIs via .env.staging), the real deterministic tools from
 * @workbench/tools-last30days (ground_queries, entity_queries, collect,
 * workflow_brief), and the real inline LLM steps (ground, entities, curate, write)
 * against the configured opencode-zen provider. It does NOT use the sidecar
 * workflow runtime — it wires the same step graph by hand so we can validate the
 * prompts + curation logic locally before any deploy.
 *
 *   bun run scripts/workflow-local.ts "Neobank Launches"
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createExaTools } from "../packages/tools-exa/src/index";
import { createRedditTools } from "../packages/tools-reddit/src/index";
import { createYouTubeTools } from "../packages/tools-youtube/src/index";
import { createGitHubTools } from "../packages/tools-github/src/index";
import { createHackerNewsTools } from "../packages/tools-hackernews/src/index";
import { createXTools } from "../packages/tools-x/src/index";
import { createPolymarketTools } from "../packages/tools-polymarket/src/index";
import { createLast30daysTools } from "../packages/tools-last30days/src/tools";
import { parseReport } from "../packages/last30days-core/src/index";
import {
  buildCurateSystemPrompt,
  buildEntityExtractSystemPrompt,
  buildGroundingSystemPrompt,
  buildWriterSystemPrompt,
} from "../workflows/last30days-research/src/prompts";

const DEFAULT_MODEL = "deepseek-v4-flash";
const WRITER_MODEL = "kimi-k2.6";

interface SourceTool {
  definition: { name: string };
  handler: (
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<string>;
}

interface FullTool {
  definition: { name: string };
  kind: string;
  handler: (
    call: { id: string; name: string; arguments: Record<string, unknown> },
    signal: AbortSignal,
  ) => Promise<{ content: unknown }>;
}

function loadEnvStaging(): Record<string, string> {
  const path = new URL("../.env.staging", import.meta.url).pathname;
  const text = readFileSync(path, "utf8");
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  return env;
}

function requireKey(env: Record<string, string>, key: string): string {
  const v = env[key];
  if (!v || v.length === 0) throw new Error(`missing ${key} in .env.staging`);
  return v;
}

function buildSourceTools(
  env: Record<string, string>,
): Map<string, SourceTool> {
  const tools = [
    ...createExaTools({ apiKey: requireKey(env, "EXA_API_KEY") }),
    ...createRedditTools({ apiKey: requireKey(env, "SCRAPECREATORS_API_KEY") }),
    ...createYouTubeTools({ apiKey: requireKey(env, "YOUTUBE_API_KEY") }),
    ...createGitHubTools({ apiKey: requireKey(env, "GITHUB_API_KEY") }),
    ...createHackerNewsTools({}),
    ...createXTools({ apiKey: requireKey(env, "XAI_API_KEY") }),
    ...createPolymarketTools({}),
  ] as unknown as SourceTool[];
  return new Map(tools.map((t) => [t.definition.name, t]));
}

function fullTool(name: string): FullTool {
  const tool = (createLast30daysTools() as unknown as FullTool[]).find(
    (t) => t.definition.name === name,
  );
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

function stringTool(name: string): SourceTool {
  const tool = (createLast30daysTools() as unknown as SourceTool[]).find(
    (t) => t.definition.name === name,
  );
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

async function callModel(
  env: Record<string, string>,
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
): Promise<string> {
  const baseUrl = requireKey(env, "OPENAI_COMPATIBLE_BASE_URL").replace(
    /\/$/,
    "",
  );
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${requireKey(env, "OPENAI_COMPATIBLE_API_KEY")}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      max_tokens: maxTokens,
      temperature: 0.4,
    }),
  });
  if (!res.ok)
    throw new Error(`model error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    choices: { message: { content: string | null } }[];
  };
  return data.choices[0]?.message.content ?? "";
}

interface Envelope {
  output: { content: string };
}

async function fetchSource(
  sources: Map<string, SourceTool>,
  tool: string,
  query: string,
  limit: number,
  signal: AbortSignal,
): Promise<Envelope> {
  const t = sources.get(tool);
  if (t === undefined) throw new Error(`missing source tool ${tool}`);
  try {
    const content = await t.handler({ query, limit }, signal);
    return { output: { content } };
  } catch (e) {
    return {
      output: { content: e instanceof Error ? e.message : String(e) },
    };
  }
}

const ROUND1 = [
  { key: "web", tool: "exa_search", limit: 25 },
  { key: "webB", tool: "exa_search", limit: 25 },
  { key: "webC", tool: "exa_search", limit: 25 },
  { key: "hackernews", tool: "hackernews_search", limit: 20 },
  { key: "github", tool: "github_activity", limit: 15 },
  { key: "reddit", tool: "reddit_search", limit: 20 },
  { key: "x", tool: "x_search", limit: 15 },
  { key: "youtube", tool: "youtube_search", limit: 12 },
  { key: "polymarket", tool: "polymarket_odds", limit: 15 },
] as const;

const ROUND2 = [
  { id: "web2", tool: "exa_search", mapKey: "web", limit: 20 },
  { id: "reddit2", tool: "reddit_search", mapKey: "reddit", limit: 30 },
  { id: "x2", tool: "x_search", mapKey: "x", limit: 20 },
  { id: "youtube2", tool: "youtube_search", mapKey: "youtube", limit: 20 },
] as const;

async function main() {
  const env = loadEnvStaging();
  const topic = process.argv[2] ?? "Neobank Launches";
  const days = 30;
  const ac = new AbortController();
  const sources = buildSourceTools(env);
  const log = (m: string) => process.stderr.write(m + "\n");

  const intakeOutput = { topic, query: topic, days };
  const steps: Record<string, unknown> = {
    intake: { output: intakeOutput },
  };

  // 1. ground (inline) -> groundQueries (tool)
  log("ground...");
  const groundReply = await callModel(
    env,
    DEFAULT_MODEL,
    buildGroundingSystemPrompt(),
    JSON.stringify(intakeOutput),
    2048,
  );
  const gq = await fullTool("last30days_ground_queries").handler(
    {
      id: "gq",
      name: "x",
      arguments: { topic, query: topic, reply: groundReply },
    },
    ac.signal,
  );
  const groundMap = gq.content as Record<string, string>;
  steps.groundQueries = { output: { content: groundMap } };

  // 2. round-1 sources
  for (const s of ROUND1) {
    log(`round1 ${s.key} (${groundMap[s.key]})...`);
    steps[s.key] = await fetchSource(
      sources,
      s.tool,
      groundMap[s.key] ?? topic,
      s.limit,
      ac.signal,
    );
  }

  // 3. entities (inline) -> entityQueries (tool)
  log("entities...");
  const entityReply = await callModel(
    env,
    DEFAULT_MODEL,
    buildEntityExtractSystemPrompt(),
    JSON.stringify(steps),
    2048,
  );
  const eq = await fullTool("last30days_entity_queries").handler(
    {
      id: "eq",
      name: "x",
      arguments: { topic, query: topic, reply: entityReply },
    },
    ac.signal,
  );
  const entityMap = eq.content as Record<string, string>;
  log(`entity queries: ${JSON.stringify(entityMap)}`);
  steps.entityQueries = { output: { content: entityMap } };

  // 4. round-2 sources
  for (const s of ROUND2) {
    log(`round2 ${s.id} (${entityMap[s.mapKey]})...`);
    steps[s.id] = await fetchSource(
      sources,
      s.tool,
      entityMap[s.mapKey] ?? topic,
      s.limit,
      ac.signal,
    );
  }

  // 5. collect (tool)
  log("collect...");
  const collect = await fullTool("last30days_collect").handler(
    { id: "co", name: "x", arguments: steps },
    ac.signal,
  );
  const collected = collect.content as {
    topic: string;
    days: number;
    items: unknown[];
    skippedSources?: unknown[];
  };
  steps.collect = { output: { content: collected } };
  log(
    `collected ${collected.items.length} items; skipped ${collected.skippedSources?.length ?? 0}`,
  );

  // 6. curate (inline, writer model)
  log("curate...");
  const curateReply = await callModel(
    env,
    DEFAULT_MODEL,
    buildCurateSystemPrompt(),
    JSON.stringify(collected),
    8192,
  );
  steps.curate = { output: { reply: curateReply } };

  // 7. brief (tool)
  const briefRaw = await stringTool("last30days_workflow_brief").handler(
    steps,
    ac.signal,
  );
  steps.brief = { output: { content: briefRaw } };
  const report = parseReport(JSON.parse(briefRaw));
  if (report === null) throw new Error("brief did not produce a valid Report");
  log(
    `BRIEF: ${report.clusters.length} themes, ${report.items.length} items, ${report.bestTakes.length} bestTakes`,
  );
  for (const c of report.clusters) {
    log(
      `  - theme "${c.title}" (${c.items.length} items, ${c.sources.join("/")})`,
    );
  }
  for (const t of report.bestTakes) {
    log(
      `  quote [${t.source} ${t.engagement}] ${t.author ?? ""}: ${t.quote.slice(0, 80)}`,
    );
  }

  // 8. write (inline, writer model)
  log("write...");
  const writerInput = JSON.stringify({ ...intakeOutput, content: briefRaw });
  const final = await callModel(
    env,
    WRITER_MODEL,
    buildWriterSystemPrompt(),
    writerInput,
    16384,
  );

  process.stdout.write("\n\n===== WORKFLOW v2 REPORT =====\n\n");
  process.stdout.write(final);
  process.stdout.write("\n");
  writeFileSync("/tmp/workflow-v2.report.md", final);
  log(
    `\nwrote /tmp/workflow-v2.report.md (${final.split(/\s+/).length} words)`,
  );
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
