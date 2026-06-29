import { describe, expect, test } from "bun:test";
import type { AnnotatedToolFactory, BaseEnv } from "@intx/agent";
import {
  HUB_RPC_ENV_KEY,
  toolCredentialEnvKey,
} from "@workbench/tool-credentials";
import { agents } from "../../tools-agents/src/interchange-tools";
import { artifact } from "../../tools-artifact/src/interchange-tools";
import { attio } from "../../tools-attio/src/interchange-tools";
import { bluesky } from "../../tools-bluesky/src/interchange-tools";
import { dispatch } from "../../tools-dispatch/src/interchange-tools";
import { exa } from "../../tools-exa/src/interchange-tools";
import { firecrawl } from "../../tools-firecrawl/src/interchange-tools";
import { gamma } from "../../tools-gamma/src/interchange-tools";
import { github } from "../../tools-github/src/interchange-tools";
import { granola } from "../../tools-granola/src/interchange-tools";
import { hackernews } from "../../tools-hackernews/src/interchange-tools";
import { last30days } from "../../tools-last30days/src/interchange-tools";
import { linear } from "../../tools-linear/src/interchange-tools";
import { polymarket } from "../../tools-polymarket/src/interchange-tools";
import { reddit } from "../../tools-reddit/src/interchange-tools";
import { scrapecreators } from "../../tools-scrapecreators/src/interchange-tools";
import { skills } from "../../tools-skills/src/interchange-tools";
import { x } from "../../tools-x/src/interchange-tools";
import { youtube } from "../../tools-youtube/src/interchange-tools";

const hubRpcCtx = {
  baseURL: "https://hub.test",
  token: "sidecar-tok",
  tenantId: "t1",
  agentId: "a1",
  principalId: "p1",
  sessionId: "s1",
};

const hubEnv = { [HUB_RPC_ENV_KEY]: hubRpcCtx } as unknown as BaseEnv;

function credentialedEnv(provider: string): BaseEnv {
  return {
    [toolCredentialEnvKey(provider)]: {
      apiKey: "test-key",
      baseURL: "https://api.test",
    },
  } as unknown as BaseEnv;
}

type ContractCase = {
  label: string;
  id: string;
  factory: AnnotatedToolFactory;
  requires: string[];
  env: BaseEnv;
  expectedToolNames?: string[];
  throwsWhenCredentialMissing?: boolean;
  unknownToolSurfacesIsError?: boolean;
};

const cases: ContractCase[] = [
  {
    label: "agents",
    id: "@workbench/tools-agents/agents",
    factory: agents,
    requires: [HUB_RPC_ENV_KEY],
    env: hubEnv,
    expectedToolNames: [
      "identity_get",
      "identity_set",
      "list_agents",
      "list_principals",
    ],
  },
  {
    label: "artifact",
    id: "@workbench/tools-artifact/artifact",
    factory: artifact,
    requires: [HUB_RPC_ENV_KEY],
    env: hubEnv,
    expectedToolNames: [
      "artifact_create",
      "artifact_find_by_title",
      "artifact_link_file",
      "artifact_link_presentation",
      "artifact_list",
      "artifact_read",
      "artifact_write",
      "write_artifact",
      "memory_load",
      "memory_save",
    ],
  },
  {
    label: "skills",
    id: "@workbench/tools-skills/skills",
    factory: skills,
    requires: [HUB_RPC_ENV_KEY],
    env: hubEnv,
    expectedToolNames: ["list_skills", "load_skill", "search_skills"],
  },
  {
    label: "dispatch",
    id: "@workbench/tools-dispatch/dispatch",
    factory: dispatch,
    requires: [HUB_RPC_ENV_KEY],
    env: hubEnv,
    expectedToolNames: ["dispatch_agent"],
  },
  {
    label: "attio",
    id: "@workbench/tools-attio/attio",
    factory: attio,
    requires: [toolCredentialEnvKey("attio")],
    env: credentialedEnv("attio"),
    expectedToolNames: [
      "attio_get_record",
      "attio_list_objects",
      "attio_list_workspace_members",
      "attio_query_records",
      "attio_search_records",
    ],
    throwsWhenCredentialMissing: true,
  },
  {
    label: "exa",
    id: "@workbench/tools-exa/exa",
    factory: exa,
    requires: [toolCredentialEnvKey("exa")],
    env: credentialedEnv("exa"),
    throwsWhenCredentialMissing: true,
  },
  {
    label: "github",
    id: "@workbench/tools-github/github",
    factory: github,
    requires: [toolCredentialEnvKey("github")],
    env: credentialedEnv("github"),
    throwsWhenCredentialMissing: true,
  },
  {
    label: "firecrawl",
    id: "@workbench/tools-firecrawl/firecrawl",
    factory: firecrawl,
    requires: [toolCredentialEnvKey("firecrawl")],
    env: credentialedEnv("firecrawl"),
    throwsWhenCredentialMissing: true,
  },
  {
    label: "granola",
    id: "@workbench/tools-granola/granola",
    factory: granola,
    requires: [toolCredentialEnvKey("granola")],
    env: credentialedEnv("granola"),
    throwsWhenCredentialMissing: true,
  },
  {
    label: "gamma",
    id: "@workbench/tools-gamma/gamma",
    factory: gamma,
    requires: [toolCredentialEnvKey("gamma")],
    env: credentialedEnv("gamma"),
    throwsWhenCredentialMissing: true,
  },
  {
    label: "linear",
    id: "@workbench/tools-linear/linear",
    factory: linear,
    requires: [toolCredentialEnvKey("linear")],
    env: credentialedEnv("linear"),
    throwsWhenCredentialMissing: true,
  },
  {
    label: "reddit",
    id: "@workbench/tools-reddit/reddit",
    factory: reddit,
    requires: [toolCredentialEnvKey("scrapecreators")],
    env: credentialedEnv("scrapecreators"),
    throwsWhenCredentialMissing: true,
  },
  {
    label: "x",
    id: "@workbench/tools-x/x",
    factory: x,
    requires: [toolCredentialEnvKey("xai")],
    env: credentialedEnv("xai"),
    throwsWhenCredentialMissing: true,
  },
  {
    label: "youtube",
    id: "@workbench/tools-youtube/youtube",
    factory: youtube,
    requires: [toolCredentialEnvKey("youtube")],
    env: credentialedEnv("youtube"),
    throwsWhenCredentialMissing: true,
  },
  {
    label: "bluesky",
    id: "@workbench/tools-bluesky/bluesky",
    factory: bluesky,
    requires: [toolCredentialEnvKey("bluesky")],
    env: credentialedEnv("bluesky"),
    throwsWhenCredentialMissing: true,
  },
  {
    label: "scrapecreators",
    id: "@workbench/tools-scrapecreators/scrapecreators",
    factory: scrapecreators,
    requires: [toolCredentialEnvKey("scrapecreators")],
    env: credentialedEnv("scrapecreators"),
    throwsWhenCredentialMissing: true,
  },
  {
    label: "hackernews",
    id: "@workbench/tools-hackernews/hackernews",
    factory: hackernews,
    requires: [],
    env: {} as BaseEnv,
    expectedToolNames: ["hackernews_search"],
    unknownToolSurfacesIsError: true,
  },
  {
    label: "polymarket",
    id: "@workbench/tools-polymarket/polymarket",
    factory: polymarket,
    requires: [],
    env: {} as BaseEnv,
    unknownToolSurfacesIsError: true,
  },
  {
    label: "last30days",
    id: "@workbench/tools-last30days/core",
    factory: last30days,
    requires: [],
    env: {} as BaseEnv,
    expectedToolNames: [
      "last30days_collect",
      "last30days_core_extract",
      "last30days_core_report",
      "last30days_entity_queries",
      "last30days_ground_queries",
      "last30days_validate",
      "last30days_workflow_brief",
    ],
  },
];

describe("workbench interchange.tools manifest", () => {
  for (const entry of cases) {
    describe(entry.label, () => {
      test("declares id, requires, and builds a non-empty bundle", () => {
        expect(typeof entry.factory).toBe("function");
        expect(entry.factory.id).toBe(entry.id);
        expect(entry.factory.requires).toEqual(entry.requires);
        const bundle = entry.factory(entry.env);
        expect(bundle.definitions.length).toBeGreaterThan(0);
        if (entry.expectedToolNames) {
          expect(bundle.definitions.map((d) => d.name).sort()).toEqual(
            [...entry.expectedToolNames].sort(),
          );
        }
      });

      if (entry.throwsWhenCredentialMissing) {
        test("throws at construction when the credential is absent", () => {
          expect(() => entry.factory({} as BaseEnv)).toThrow();
        });
      }

      if (entry.unknownToolSurfacesIsError) {
        test("unknown tool names surface as isError", async () => {
          const bundle = entry.factory(entry.env);
          const result = await bundle.run(
            { id: "call-1", name: "not_a_tool", arguments: {} },
            AbortSignal.timeout(1000),
          );
          expect(result.isError).toBe(true);
        });
      }
    });
  }
});
