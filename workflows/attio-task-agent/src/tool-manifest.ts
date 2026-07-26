import { manifestFromHubToolEntries } from "@workbench/tool-manifest";
import { ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION } from "./persist-tool";

export const toolManifestFile = {
  factories: [
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
