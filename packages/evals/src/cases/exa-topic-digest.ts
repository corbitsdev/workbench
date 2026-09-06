// CL-7469: "we need someone to watch our Exa topics and post a digest to
// this bench" — Myra coordinates rather than declining or answering
// inline: the same interview -> tool-map -> memory -> specialist ->
// routine flow as ai-daily-research, with the plan itself naming the
// teammate (agent/workflow) it will create.
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

export const exaTopicDigestEval = defineEval({
  name: "exa-topic-digest",
  description:
    "'we need someone to watch our Exa topics and post a digest to this " +
    "bench' -> interview (topics/cadence) -> specialist teammate that " +
    "watches Exa -> routine posting the digest here",
  steps: [
    {
      human:
        "we need someone to watch our Exa topics and post a digest to " +
        "this bench",
      expect: [
        asksQuestions({ max: 4 }),
        noToolCalls(["create_agent", "routine_create", "routine_run_now"]),
        noBuildBeforeAnswers(1),
        judge(
          "The reply proposes creating a teammate (an agent or workflow) " +
            "to own this job rather than declining the request or " +
            "trying to answer it inline as a one-off.",
        ),
      ],
    },
    {
      human:
        "topics: competitor launches and pricing changes; cadence: " +
        "daily every morning; post the digest here in this chat",
      expect: [
        noBuildBeforeAnswers(1),
        memoryWritten(["daily"]),
        namesRequiredTools([CREATE_AGENT_TOOL]),
        agentCreatedInWorkbench(),
      ],
    },
    {
      human: "yes, set up the daily digest routine",
      expect: [
        routineCreatedOnlyAfterOk(2),
        approvalGated([ROUTINE_CREATE_TOOL]),
        namesRequiredTools([ROUTINE_CREATE_TOOL]),
        routineCreated({ trigger: "daily" }),
        judge(
          "The reply confirms the digest routine is set up in a warm, " +
            "direct teammate tone — not a wizard checklist, not pushy.",
        ),
      ],
    },
  ],
});
