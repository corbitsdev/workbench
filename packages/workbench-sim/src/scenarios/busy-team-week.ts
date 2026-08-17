// Scenario 1: "busy team week" — one workbench, three humans, two
// agents, five virtual days. Each day: a kickoff root message, a spread
// of standalone posts (some mentioning an agent), four thread replies
// onto the day's root, two routine fires, then a quiet gap. Totals:
// 110 human messages (20 of them thread replies) and 10 routine fires.

import type { Scenario, Step } from "../scenario";
import { humanSay, label, routineFire, waitQuiet } from "../scenario";

const ACTORS = ["ana", "ben", "chika"] as const;

const TOPICS = [
  "shipping the quarterly report draft",
  "the flaky deploy pipeline",
  "customer onboarding checklist",
  "next week's roadmap review",
  "the search latency regression",
  "docs for the new billing flow",
  "hiring loop scheduling",
  "the migration dry run",
];

function daySteps(day: number): Step[] {
  const steps: Step[] = [label(`day ${day}`)];
  const rootRef = `day${day}-root`;
  steps.push(
    humanSay(
      ACTORS[(day - 1) % ACTORS.length] ?? "ana",
      `Day ${day} kickoff: priorities and blockers, please.`,
      { ref: rootRef },
    ),
  );

  // 17 standalone posts per day, rotating authors and topics; every
  // sixth one mentions an agent so mention fan-out gets real volume.
  for (let post = 0; post < 17; post += 1) {
    const actor = ACTORS[(post + day) % ACTORS.length] ?? "ana";
    const topic = TOPICS[(post + day) % TOPICS.length] ?? TOPICS[0] ?? "";
    const mentions = post % 6 === 5 ? { mentions: ["scout"] as const } : {};
    steps.push(
      humanSay(actor, `Update ${post + 1} on ${topic} (day ${day}).`, mentions),
    );
  }

  // Four thread replies onto the day's kickoff root.
  for (let reply = 0; reply < 4; reply += 1) {
    const actor = ACTORS[(reply + day + 1) % ACTORS.length] ?? "ben";
    steps.push(
      humanSay(actor, `Thread follow-up ${reply + 1} for day ${day}.`, {
        inReplyToRef: rootRef,
      }),
    );
  }

  // Two "daily" routine fires, time-compressed.
  steps.push(routineFire("daily-digest"));
  steps.push(routineFire("daily-digest"));
  steps.push(waitQuiet(1_000));
  return steps;
}

export const busyTeamWeek: Scenario = {
  name: "busy-team-week",
  description:
    "One workbench, three humans, two agents, five compressed virtual " +
    "days: 110 messages including 20 thread replies, agent mentions, " +
    "and 10 routine fires, judged on thread integrity, drops, latency, " +
    "and row growth.",
  humans: {
    ana: "Ana Ferreira",
    ben: "Ben Okafor",
    chika: "Chika Watanabe",
  },
  agents: [
    { key: "scout", workflow: "echo" },
    { key: "relay", workflow: "echo" },
  ],
  routines: [
    { key: "daily-digest", name: "Daily digest", workflow: "heartbeat" },
  ],
  steps: [1, 2, 3, 4, 5].flatMap(daySteps),
};
