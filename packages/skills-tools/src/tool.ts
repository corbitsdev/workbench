// The `@corbits/skills-tools` bundle: Myra's in-chat way to capture
// repeatable know-how as a workbench skill (`create_skill`/
// `update_skill`), browse what already exists (`list_skills`), and pin
// an existing skill onto any agent definition in the workbench
// (`pin_skill`) — the CL-Myra-manager-tools counterpart to
// `@corbits/capability-tools`' `request_capability`, over the same
// workflow-run-authenticated surfaces `./client.ts` calls.
//
// Every write here is `approval: "ask"` (`@intx/agent`'s native
// per-invocation gate, `vendor/intx/agent/src/tool.ts`): the reactor
// suspends the call as a pending approval BEFORE this bundle's `run`
// ever executes, and only resumes once a human allows it — a skill's
// body or a definition's pinned-skill list is workbench-durable state,
// never written on a model's say-so alone. `list_skills` is plain
// reading and carries no approval gate.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";

import {
  createSkill,
  listSkills,
  loadSkill,
  pinSkill,
  updateSkill,
  type SkillsToolClientConfig,
} from "./client";

export const LIST_SKILLS_TOOL = "list_skills";
export const READ_SKILL_TOOL = "read_skill";
export const CREATE_SKILL_TOOL = "create_skill";
export const UPDATE_SKILL_TOOL = "update_skill";
export const PIN_SKILL_TOOL = "pin_skill";

/** Env this bundle needs beyond `BaseEnv`: the run's reach into both
 * hub surfaces it calls, mirroring `@corbits/capability-tools`'
 * `WorkflowCapabilityEnv`. */
export interface WorkflowSkillsWriteEnv extends BaseEnv {
  readonly hubSkillsUrl: string;
  readonly hubAgentDirectoryUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

function clientConfig(env: WorkflowSkillsWriteEnv): SkillsToolClientConfig {
  return {
    hubSkillsUrl: env.hubSkillsUrl,
    hubAgentDirectoryUrl: env.hubAgentDirectoryUrl,
    sidecarToken: env.sidecarToken,
    address: env.address,
  };
}

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    isError: true,
    content: err instanceof Error ? err.message : String(err),
  };
}

const CreateSkillInput = type({
  name: "string > 0",
  description: "string > 0",
  body: "string > 0",
});

// `name`, not `assetId` — deliberate: `SkillRegistry` (`@corbits/skills`)
// is name-keyed throughout (`load`, `versions`, `restore`, `setScope`
// all take a skill name, never an asset id), so a tool built over it
// stays in that same vocabulary rather than surfacing an id the model
// has no other way to have learned.
const UpdateSkillInput = type({
  name: "string > 0",
  body: "string > 0",
  "description?": "string > 0",
});

const PinSkillInput = type({
  definitionId: "string > 0",
  skillName: "string > 0",
});

const ReadSkillInput = type({
  name: "string > 0",
});

async function runReadSkill(
  env: WorkflowSkillsWriteEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = ReadSkillInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`read_skill received invalid input: ${parsed.summary}`),
    );
  }
  try {
    const skill = await loadSkill(clientConfig(env), parsed.name);
    return {
      callId: call.id,
      isError: false,
      content: `# ${skill.name}\n${skill.description}\n\n${skill.body}`,
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runListSkills(
  env: WorkflowSkillsWriteEnv,
  call: ToolCall,
): Promise<ToolResult> {
  try {
    const skills = await listSkills(clientConfig(env));
    return {
      callId: call.id,
      isError: false,
      content:
        skills.length === 0
          ? "No skills exist in this workbench yet."
          : skills
              .map((skill) => `${skill.name}: ${skill.description}`)
              .join("\n"),
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runCreateSkill(
  env: WorkflowSkillsWriteEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = CreateSkillInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`create_skill received invalid input: ${parsed.summary}`),
    );
  }
  try {
    const skill = await createSkill(clientConfig(env), parsed);
    return {
      callId: call.id,
      isError: false,
      content: `Created the "${skill.name}" skill.`,
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runUpdateSkill(
  env: WorkflowSkillsWriteEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = UpdateSkillInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`update_skill received invalid input: ${parsed.summary}`),
    );
  }
  try {
    const skill = await updateSkill(clientConfig(env), parsed);
    return {
      callId: call.id,
      isError: false,
      content: `Updated the "${skill.name}" skill.`,
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runPinSkill(
  env: WorkflowSkillsWriteEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = PinSkillInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`pin_skill received invalid input: ${parsed.summary}`),
    );
  }
  try {
    const skills = await pinSkill(clientConfig(env), parsed);
    return {
      callId: call.id,
      isError: false,
      content: `Pinned "${parsed.skillName}" — this definition now carries: ${skills.join(", ")}.`,
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

/**
 * The `@corbits/skills-tools` bundle factory: four tools over the
 * workbench skill registry and definition-skill pins.
 */
export const skillsTools = defineTool<WorkflowSkillsWriteEnv>({
  id: "@corbits/skills-tools/skills",
  requires: ["hubSkillsUrl", "hubAgentDirectoryUrl", "sidecarToken", "address"],
  definitions: [
    { name: LIST_SKILLS_TOOL },
    { name: READ_SKILL_TOOL },
    { name: CREATE_SKILL_TOOL, approval: "ask" },
    { name: UPDATE_SKILL_TOOL, approval: "ask" },
    { name: PIN_SKILL_TOOL, approval: "ask" },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: LIST_SKILLS_TOOL,
        description:
          "List every skill visible in this workbench, as a name and " +
          "one-line description for each. Use this to see what already " +
          "exists before offering to create a new one.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: READ_SKILL_TOOL,
        description:
          "Read one skill's full instructions by name. Use this when " +
          "you are about to do the thing a skill covers — load it and " +
          "follow it rather than working from the one-line description.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The exact name of the skill to read.",
            },
          },
          required: ["name"],
        },
      },
      {
        name: CREATE_SKILL_TOOL,
        description:
          "Capture repeatable know-how as a new, workbench-wide skill. " +
          "Use this only once a genuinely reusable procedure has come " +
          "up in conversation — never speculatively. A human must " +
          "approve before the skill is created.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                'A lowercase, hyphenated skill name (e.g. "triage-bugs").',
            },
            description: {
              type: "string",
              description:
                "One sentence on what the skill does and when to use it.",
            },
            body: {
              type: "string",
              description: "The skill's full instructions, in Markdown.",
            },
          },
          required: ["name", "description", "body"],
        },
      },
      {
        name: UPDATE_SKILL_TOOL,
        description:
          "Republish an existing skill's instructions — a new version " +
          "on the same skill, not a new skill. Omit description to " +
          "leave it exactly as it already is. A human must approve " +
          "before the update is written.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The exact name of the existing skill to update.",
            },
            body: {
              type: "string",
              description:
                "The skill's full, replacement instructions, in Markdown.",
            },
            description: {
              type: "string",
              description:
                "Optional replacement one-line description. Left unset, " +
                "the skill's current description is kept as-is.",
            },
          },
          required: ["name", "body"],
        },
      },
      {
        name: PIN_SKILL_TOOL,
        description:
          "Pin an existing skill onto an agent definition in this " +
          "workbench, so every run of that agent gets the skill listed " +
          "as available to it. Works on any definition in the " +
          "workbench, not only this agent's own. A human must approve " +
          "before the pin is written.",
        inputSchema: {
          type: "object",
          properties: {
            definitionId: {
              type: "string",
              description:
                "The id of the agent definition to pin the skill onto.",
            },
            skillName: {
              type: "string",
              description: "The exact name of an existing skill.",
            },
          },
          required: ["definitionId", "skillName"],
        },
      },
    ],
    run: (call: ToolCall, _signal: AbortSignal) => {
      switch (call.name) {
        case LIST_SKILLS_TOOL:
          return runListSkills(env, call);
        case READ_SKILL_TOOL:
          return runReadSkill(env, call);
        case CREATE_SKILL_TOOL:
          return runCreateSkill(env, call);
        case UPDATE_SKILL_TOOL:
          return runUpdateSkill(env, call);
        case PIN_SKILL_TOOL:
          return runPinSkill(env, call);
        default:
          return Promise.resolve(
            errorResult(
              call.id,
              new Error(`@corbits/skills-tools: unknown tool "${call.name}"`),
            ),
          );
      }
    },
  }),
});
