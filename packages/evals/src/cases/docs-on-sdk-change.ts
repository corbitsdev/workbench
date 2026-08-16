// CL-6143 case 2: "automatically update my docs when my SDK changes" —
// the same interview -> tool-map -> memory -> specialist -> routine
// flow, but the routine is webhook-triggered (see
// packages/webhook-triggers) rather than a schedule, and the specialist
// must never commit a doc change without an explicit review/approval
// step, per the owner's script.
import { defineEval } from "../define-eval.ts";
import {
  agentCreatedInWorkbench,
  approvalGated,
  asksQuestions,
  judge,
  memoryWritten,
  namesRequiredTools,
  noBuildBeforeAnswers,
  noToolCalls,
  routineCreated,
  routineCreatedOnlyAfterOk,
} from "../scorers/scorers.ts";
import {
  CREATE_AGENT_TOOL,
  ROUTINE_CREATE_TOOL,
} from "../scorers/tool-names.ts";

export const docsOnSdkChangeEval = defineEval({
  name: "docs-on-sdk-change",
  description:
    "'automatically update my docs when my SDK changes' -> interview " +
    "(repo, docs location, review-before-commit?) -> github-tools " +
    "agent -> webhook-triggered routine with approval before any write",
  steps: [
    {
      human: "automatically update my docs when my SDK changes",
      expect: [
        asksQuestions({ max: 4 }),
        noToolCalls(["create_agent", "routine_create", "dispatch_task"]),
        noBuildBeforeAnswers(1),
      ],
    },
    {
      human:
        "repo: github.com/example/sdk; docs live in the docs/ folder of " +
        "the same repo; yes, always review the diff before committing " +
        "anything",
      expect: [
        noBuildBeforeAnswers(1),
        memoryWritten(["docs/"]),
        namesRequiredTools([CREATE_AGENT_TOOL]),
        agentCreatedInWorkbench(),
      ],
    },
    {
      human: "looks good, wire up the webhook routine",
      expect: [
        routineCreatedOnlyAfterOk(2),
        approvalGated([ROUTINE_CREATE_TOOL]),
        namesRequiredTools([ROUTINE_CREATE_TOOL]),
        routineCreated({ trigger: "webhook" }),
        judge(
          "The reply confirms the webhook routine is wired up AND makes " +
            "clear no doc change ever commits without a human reviewing " +
            "it first.",
        ),
      ],
    },
  ],
});
