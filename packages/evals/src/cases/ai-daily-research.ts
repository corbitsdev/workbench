// CL-6143 case 1: "do research on AI daily for me" — the owner's
// canonical interview -> tool-map -> memory -> specialist -> routine
// flow. Expects Myra to: (1) ask a short interview about
// topics/sources/cadence/delivery rather than building anything first,
// (2) create a web-search-tools researcher agent invited into this
// workbench, (3) write the choices to firm memory, and (4) create the
// daily delivery routine only after an explicit go-ahead.
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

export const aiDailyResearchEval = defineEval({
  name: "ai-daily-research",
  description:
    "'do research on AI daily for me' -> interview (topics/sources/" +
    "cadence/delivery) -> web-search-tools researcher agent -> daily " +
    "routine delivering here",
  steps: [
    {
      human: "do research on AI daily for me",
      expect: [
        asksQuestions({ max: 4 }),
        noToolCalls(["create_agent", "routine_create", "dispatch_task"]),
        noBuildBeforeAnswers(1),
      ],
    },
    {
      human:
        "topics: new model releases and agent tooling; sources: X and " +
        "Hacker News; cadence: daily every morning; deliver it here in " +
        "this chat",
      expect: [
        noBuildBeforeAnswers(1),
        memoryWritten(["daily"]),
        namesRequiredTools([CREATE_AGENT_TOOL]),
        agentCreatedInWorkbench(),
      ],
    },
    {
      human: "yes, go ahead and set up the daily routine",
      expect: [
        routineCreatedOnlyAfterOk(2),
        approvalGated([ROUTINE_CREATE_TOOL]),
        namesRequiredTools([ROUTINE_CREATE_TOOL]),
        routineCreated({ trigger: "daily" }),
        judge(
          "The reply confirms the routine is set up in a warm, direct " +
            "teammate tone — not a wizard checklist, not pushy.",
        ),
      ],
    },
  ],
});
