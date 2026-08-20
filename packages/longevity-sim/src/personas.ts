import { pick } from "./prng";

export interface Persona {
  key: string;
  name: string;
  role: string;
  topics: readonly string[];
  cadenceWeight: number;
}

type Shape = (topic: string, simDay: number, name: string) => string;

const AE_SHAPES: readonly Shape[] = [
  (topic) => `Pipeline update: ${topic} moved to verbal — paperwork this week.`,
  (topic) =>
    `Blocker on ${topic}: procurement wants a redline before signature.`,
  (topic) =>
    `Just got off the call with ${topic}, they want a second demo for their VP.`,
  (topic) =>
    `Anyone have bandwidth to help me prep the ${topic} proposal tonight?`,
  (topic, simDay) =>
    `Day ${simDay}: ${topic} still stuck in security review, chasing them again.`,
];

const SDR_SHAPES: readonly Shape[] = [
  (topic) => `Booked a discovery call with ${topic} for Thursday.`,
  (topic) => `${topic} went cold after three touches, moving to nurture.`,
  (topic) =>
    `Handing ${topic} off to an AE now that they replied to the sequence.`,
  (topic) =>
    `Quick question — does ${topic} already have an open opportunity in the pipeline?`,
  (topic, simDay) =>
    `Day ${simDay} outreach recap: ${topic} opened the email twice, no reply yet.`,
];

const SALES_OPS_SHAPES: readonly Shape[] = [
  (topic) =>
    `Pulled the ${topic} report — conversion rate is down from last cycle.`,
  (topic) =>
    `Blocker: ${topic} field is missing on half the records after the CRM sync.`,
  (topic) =>
    `Handing the ${topic} dashboard back to the team, refresh is live.`,
  (topic) =>
    `Question — should ${topic} count toward this quarter's attainment or next?`,
  (topic, simDay) =>
    `Day ${simDay} data check: ${topic} numbers reconciled against finance.`,
];

const MANAGER_SHAPES: readonly Shape[] = [
  (topic) =>
    `Forecast call: ${topic} is the deal that decides if we hit this month.`,
  (topic) =>
    `Blocker on ${topic} — need to loop in leadership before we discount further.`,
  (topic) => `Handing coaching notes on ${topic} over to the rep now.`,
  (topic) => `Question for the team — who else is touching ${topic} this week?`,
  (topic, simDay) =>
    `Day ${simDay} standup: ${topic} is the one to watch this sprint.`,
];

const CS_SHAPES: readonly Shape[] = [
  (topic) => `Renewal update: ${topic} confirmed budget for another year.`,
  (topic) => `Blocker on ${topic} — usage dropped and champion went quiet.`,
  (topic) =>
    `Handing the ${topic} QBR deck to sales, expansion opportunity there.`,
  (topic) =>
    `Question — has anyone heard from ${topic} since the outage ticket?`,
  (topic, simDay) =>
    `Day ${simDay} health check: ${topic} score moved back to green.`,
];

const SE_SHAPES: readonly Shape[] = [
  (topic) =>
    `Ran the technical deep dive for ${topic}, integration questions all answered.`,
  (topic) =>
    `Blocker on ${topic}: their security team wants a pen test summary first.`,
  (topic) =>
    `Handing the ${topic} POC environment over, credentials are in the thread.`,
  (topic) =>
    `Question — does ${topic} need the SSO walkthrough again for the new stakeholder?`,
  (topic, simDay) =>
    `Day ${simDay}: ${topic} POC is passing every test case so far.`,
];

const REVOPS_SHAPES: readonly Shape[] = [
  (topic) =>
    `Territory update: ${topic} is being reassigned after the restructure.`,
  (topic) =>
    `Blocker: ${topic} routing rule is misfiring, leads landing in the wrong queue.`,
  (topic) => `Handing the ${topic} comp plan model back for legal sign-off.`,
  (topic) =>
    `Question — is ${topic} in scope for the new territory carving pass?`,
  (topic, simDay) =>
    `Day ${simDay}: ${topic} automation shipped, no more manual routing.`,
];

const VP_SHAPES: readonly Shape[] = [
  (topic) => `Board prep note: ${topic} is the headline logo for this quarter.`,
  (topic) =>
    `Blocker on ${topic} — need pricing exception approved by finance today.`,
  (topic) =>
    `Handing the ${topic} exec sponsor intro to the AE, warm and ready.`,
  (topic) =>
    `Question — where do we stand on ${topic} versus the competitive threat?`,
  (topic, simDay) =>
    `Day ${simDay}: ${topic} is the deal I'm walking the board through.`,
];

export const SALES_TEAM: readonly Persona[] = [
  {
    key: "briar",
    name: "Briar Holloway",
    role: "Account Executive",
    topics: ["Marrowgate Logistics", "Fennwick Retail", "Cobalt Peak Foods"],
    cadenceWeight: 3,
  },
  {
    key: "dax",
    name: "Dax Ferreira",
    role: "Account Executive",
    topics: ["Sablewood Insurance", "Northfell Utilities", "Thistledown Media"],
    cadenceWeight: 3,
  },
  {
    key: "ivy",
    name: "Ivy Tanaka-Reyes",
    role: "SDR",
    topics: [
      "Quillstone Manufacturing",
      "Redbrick Analytics",
      "Palefire Studios",
    ],
    cadenceWeight: 4,
  },
  {
    key: "oren",
    name: "Oren Vasquez",
    role: "SDR",
    topics: ["Amberlight Health", "Driftmark Shipping", "Grovewell Energy"],
    cadenceWeight: 4,
  },
  {
    key: "maple",
    name: "Maple Chen-Okafor",
    role: "Sales Ops",
    topics: [
      "Q3 conversion report",
      "lead-routing rules",
      "quota attainment sheet",
    ],
    cadenceWeight: 2,
  },
  {
    key: "gideon",
    name: "Gideon Novak",
    role: "Sales Manager",
    topics: [
      "Marrowgate Logistics",
      "Sablewood Insurance",
      "team pipeline review",
    ],
    cadenceWeight: 2,
  },
  {
    key: "wren",
    name: "Wren Adeyemi",
    role: "Customer Success",
    topics: [
      "Bellcrest Hospitality",
      "Ashgrove Pharma",
      "Ironvale Construction",
    ],
    cadenceWeight: 3,
  },
  {
    key: "silas",
    name: "Silas Petrov",
    role: "Solutions Engineer",
    topics: ["Fennwick Retail", "Quillstone Manufacturing", "SSO rollout"],
    cadenceWeight: 2,
  },
  {
    key: "farrah",
    name: "Farrah Lindqvist",
    role: "RevOps",
    topics: ["East region territory map", "comp plan v3", "lead scoring model"],
    cadenceWeight: 1,
  },
  {
    key: "toby",
    name: "Toby Ekwueme",
    role: "VP Sales",
    topics: ["Northfell Utilities", "Cobalt Peak Foods", "annual board deck"],
    cadenceWeight: 1,
  },
];

const SHAPES_BY_ROLE: Record<string, readonly Shape[]> = {
  "Account Executive": AE_SHAPES,
  SDR: SDR_SHAPES,
  "Sales Ops": SALES_OPS_SHAPES,
  "Sales Manager": MANAGER_SHAPES,
  "Customer Success": CS_SHAPES,
  "Solutions Engineer": SE_SHAPES,
  RevOps: REVOPS_SHAPES,
  "VP Sales": VP_SHAPES,
};

export function utterance(
  persona: Persona,
  rng: () => number,
  simDay: number,
): string {
  const shapes = SHAPES_BY_ROLE[persona.role];
  if (shapes === undefined) {
    throw new Error(`utterance: no message shapes for role "${persona.role}"`);
  }
  const shape = pick(rng, shapes);
  const topic = pick(rng, persona.topics);
  return shape(topic, simDay, persona.name);
}
