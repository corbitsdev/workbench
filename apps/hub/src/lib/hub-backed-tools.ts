import { AGENTS_HUB_TOOLS } from "@workbench/tools-agents";
import { DISPATCH_HUB_TOOLS } from "@workbench/tools-dispatch";
import { ARTIFACT_HUB_TOOLS } from "./artifact-tools";
import { FILEPARSER_HUB_TOOLS } from "./file-parser-tools";
import { MEMORY_HUB_TOOLS } from "./memory-tools";
import { LIST_AGENTS_HUB_TOOLS } from "../tools/list-agents";
import { INVOKE_AGENT_HUB_TOOLS } from "../tools/invoke-agent";
import { IDENTITY_HUB_TOOLS } from "../tools/identity";
import { SKILLS_HUB_TOOLS } from "../tools/list-skills";
import { WRITE_ARTIFACT_HUB_TOOLS } from "../tools/write-artifact";
import { GAMMA_TEMPLATES_HUB_TOOLS } from "../tools/gamma-templates";
import { WORKFLOWS_HUB_TOOLS } from "../tools/workflow-run-tools";
import { VERCEL_DEPLOY_ARTIFACT_HUB_TOOLS } from "../tools/vercel-deploy-artifact";
import { TASK_HUB_TOOLS } from "../tools/task-tools";
import type { ContextToolEntry } from "./tool-registry";

// The hub-backed tools served over the scoped `/api/internal/hub-tools/run`
// endpoint. These tools' definitions live in `@workbench/tools-*` packages
// (materialized into the sidecar as native tarballs) but they execute
// hub-side because they touch the hub-owned db/services. This map is the
// authoritative execution registry for that endpoint — separate from
// KNOWN_TOOLS, which the legacy proxy continues to serve during coexistence.
export const HUB_BACKED_TOOLS: Record<string, ContextToolEntry> = {
  ...ARTIFACT_HUB_TOOLS,
  ...FILEPARSER_HUB_TOOLS,
  ...MEMORY_HUB_TOOLS,
  ...WRITE_ARTIFACT_HUB_TOOLS,
  ...LIST_AGENTS_HUB_TOOLS,
  ...IDENTITY_HUB_TOOLS,
  ...SKILLS_HUB_TOOLS,
  ...AGENTS_HUB_TOOLS,
  ...DISPATCH_HUB_TOOLS,
  ...INVOKE_AGENT_HUB_TOOLS,
  ...GAMMA_TEMPLATES_HUB_TOOLS,
  ...WORKFLOWS_HUB_TOOLS,
  ...VERCEL_DEPLOY_ARTIFACT_HUB_TOOLS,
  ...TASK_HUB_TOOLS,
};
