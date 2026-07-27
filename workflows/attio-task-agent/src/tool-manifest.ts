import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import {
  ATTIO_TASK_AGENT_CLARIFICATION_GATE_DEFINITION,
  ATTIO_TASK_AGENT_MEMBER_SELECTION_GATE_DEFINITION,
  ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION,
  ATTIO_TASK_AGENT_REVIEW_GATE_DEFINITION,
  ATTIO_TASK_AGENT_SYNC_APPROVAL_GATE_DEFINITION,
  ATTIO_TASK_AGENT_TASK_SELECTION_GATE_DEFINITION,
} from "./tools";

export const toolManifestFile = {
  factories: [
    manifestFromHubToolEntries({
      factoryId: "@workbench/workflow-attio-task-agent/core",
      packageName: "@workbench/workflow-attio-task-agent",
      providerName: null,
      entries: {
        [ATTIO_TASK_AGENT_MEMBER_SELECTION_GATE_DEFINITION.name]: {
          sideEffect: "read",
        },
        [ATTIO_TASK_AGENT_TASK_SELECTION_GATE_DEFINITION.name]: {
          sideEffect: "read",
        },
        [ATTIO_TASK_AGENT_CLARIFICATION_GATE_DEFINITION.name]: {
          sideEffect: "read",
        },
        [ATTIO_TASK_AGENT_REVIEW_GATE_DEFINITION.name]: {
          sideEffect: "read",
        },
        [ATTIO_TASK_AGENT_SYNC_APPROVAL_GATE_DEFINITION.name]: {
          sideEffect: "read",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
    manifestFromHubToolEntries({
      factoryId: "@workbench/workflow-attio-task-agent/persist",
      packageName: "@workbench/workflow-attio-task-agent",
      providerName: null,
      entries: {
        [ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION.name]: {
          sideEffect: "write",
        },
      },
      myraCatalog: null,
      credentialCatalog: null,
    }),
  ],
};
