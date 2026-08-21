// `bun src/cli.ts --config <path.json>`: reads DATABASE_URL and a
// REQUIRED REAL_TARGETS env (JSON array of `InferenceTarget` — each a
// real Ollama origin dialed through the `openai-compatible` adapter,
// e.g. `baseURL: "https://<tailscale-host>/v1"`), boots the stack,
// builds and executes the plan, writes the markdown report, prints its
// path and verdict, and exits 1 on any S1 defect. There is no
// noop/Anthropic fallback mode: every agent this CLI creates is a real
// agent pinned at one of REAL_TARGETS' catalog models.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type } from "arktype";

import { parseCampaignConfig } from "./config";
import { buildPlan, MENTION_AGENT_KEY, REAL_AGENT_KEY } from "./plan";
import { renderCampaignReport, reportVerdict } from "./report";
import { SALES_TEAM } from "./personas";
import {
  bootLongevityStack,
  type AgentDefinitionSpec,
  type InferenceTarget,
  type RoutineSpec,
  type SkillSpec,
} from "./stack";
import { executeCampaign } from "./engine";

const inferenceTarget = type({
  label: "string",
  provider: "string",
  model: "string",
  baseURL: "string",
  apiKey: "string",
});
const realTargetsSchema = inferenceTarget.array();

/** REAL_TARGETS is required: this CLI seeds no noop/Anthropic fallback
 * catalog chain, so a campaign with no real target has no model any
 * agent could ever be pinned at. */
function parseRealTargets(raw: string | undefined): readonly InferenceTarget[] {
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      "REAL_TARGETS is required (JSON array of InferenceTarget) — this " +
        "campaign has no noop/Anthropic fallback; every agent needs a " +
        "real Ollama target to pin its model at",
    );
  }
  const parsed = realTargetsSchema(JSON.parse(raw));
  if (parsed instanceof type.errors) {
    throw new Error(`REAL_TARGETS: ${parsed.summary}`);
  }
  if (parsed.length === 0) {
    throw new Error("REAL_TARGETS must name at least one InferenceTarget");
  }
  return parsed;
}

const SKILL_MARKER_NAME = "campaign-self-improvement";

/** One real agent definition per `realTargets` entry (cycling if the
 * roster below outgrows the fleet) — every agent is real inference,
 * pinned at that target's own catalog model. The fleet is expected to
 * grow by adding more `realTargets` entries, never by this function
 * inventing a stub/noop path. */
function buildAgentSpecs(
  realTargets: readonly InferenceTarget[],
): AgentDefinitionSpec[] {
  // Order matters twice: index 0 (the plan's measured-turn target) owns
  // the marker skill, and the round-robin below maps roster order onto
  // `realTargets` order — so the lead agent lands on the first target.
  const roster = [
    { key: REAL_AGENT_KEY, handle: REAL_AGENT_KEY, name: "Sales Analyst" },
    { key: "deal-desk", handle: "deal-desk", name: "Deal Desk" },
    { key: "ops-analyst", handle: "ops-analyst", name: "Ops Analyst" },
    {
      key: MENTION_AGENT_KEY,
      handle: MENTION_AGENT_KEY,
      name: "Support Copilot",
    },
  ];
  return roster.map((entry, index) => {
    const target = realTargets[index % realTargets.length];
    if (target === undefined) {
      throw new Error(
        "unreachable: realTargets is non-empty by parseRealTargets",
      );
    }
    return {
      key: entry.key,
      handle: entry.handle,
      name: entry.name,
      systemPrompt:
        "You are a real-model assistant helping a sales team. Keep replies short and concrete.",
      real: true,
      targetLabel: target.label,
      skills: index === 0 ? [SKILL_MARKER_NAME] : [],
    };
  });
}

const ROUTINE_SPECS: RoutineSpec[] = [
  { key: "heartbeat-1", name: "Daily heartbeat" },
];

function skillSpecs(): SkillSpec[] {
  return [
    {
      name: SKILL_MARKER_NAME,
      description: "Longevity campaign self-improvement marker skill.",
      body: "Reply normally; this skill's instructions are updated during the campaign.",
    },
  ];
}

function parseArgs(argv: readonly string[]): { configPath: string } {
  const flagIndex = argv.indexOf("--config");
  const configPath = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  if (configPath === undefined) {
    throw new Error("usage: bun src/cli.ts --config <path.json>");
  }
  return { configPath };
}

async function main(): Promise<number> {
  const { configPath } = parseArgs(process.argv.slice(2));
  const configRaw = JSON.parse(await readFile(configPath, "utf8"));
  const config = parseCampaignConfig(configRaw);

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error(
      "DATABASE_URL is not set; the campaign needs a reachable Postgres",
    );
  }
  const realTargets = parseRealTargets(process.env["REAL_TARGETS"]);

  const stack = await bootLongevityStack(
    SALES_TEAM,
    buildAgentSpecs(realTargets),
    ROUTINE_SPECS,
    { databaseUrl, realTargets, skills: skillSpecs() },
  );

  try {
    const steps = buildPlan(config);
    const report = await executeCampaign(stack, steps, config, {
      onProgress: (info) => {
        process.stdout.write(`[${info.atMessages}] ${info.kind}\n`);
      },
    });

    const outputDir = path.join(import.meta.dir, "..", "output");
    await mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${report.name}.md`);
    await writeFile(outputPath, renderCampaignReport(report), "utf8");

    process.stdout.write(`report written to ${outputPath}\n`);
    process.stdout.write(`${reportVerdict(report)}\n`);

    const hasS1Defect = report.defects.some(
      (defect) => defect.severity === "S1",
    );
    return hasS1Defect ? 1 : 0;
  } finally {
    await stack.close();
  }
}

// Top-level await (not a floating `main().then(...)` chain) is load-bearing:
// a detached promise does not keep Bun's event loop alive, and the boot
// sequence has handle-free moments where a drained loop exits 0 mid-campaign.
try {
  process.exit(await main());
} catch (error) {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
}
