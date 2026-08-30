// The three reviewer definitions a pull-request review fans out to.
// Each one is a lens, not a whole opinion: architecture judges whether
// the shape is sound, correctness hunts defects with receipts, and
// release risk says what actually blocks shipping. Their prompts are
// adapted from the reviewer personas the team already runs by hand, so
// a review posted here reads the way the team's own reviews read.
//
// A definition here is plain data: an id, a handle, a display name, and
// a system prompt. That is exactly what the agent-directory create path
// takes, so the same three definitions can be installed as agents in a
// workbench and driven by this package's own review run.

/**
 * The JSON contract a reviewer replies under **when a machine parses the
 * reply back** — `./review-run.ts`'s pass runner, and nothing else.
 *
 * It is deliberately not part of `ReviewerDefinition.systemPrompt`. The
 * same prompts install these reviewers as ordinary chat agents
 * (`./agent-requests.ts`), and a reviewer carrying this contract answers
 * a person in the room with `{"summary": ..., "findings": []}` instead of
 * a sentence (CL-7189). Append it with `reviewerReportPrompt` on the one
 * path that reads JSON back.
 */
export const REVIEWER_REPORT_CONTRACT =
  "Reply with JSON and nothing else — no prose before or after, no code " +
  'fence. Shape: {"summary": string, "findings": [{"severity": ' +
  '"blocking" | "should-fix" | "later", "file": string, "line": number, ' +
  '"summary": string, "existingCode": string, "suggestedFix": string}]}. ' +
  "`summary` is one or two sentences on what you looked at and what you " +
  "concluded. Each finding names the file it is about; include `line` " +
  "only when you can point at a specific right-hand line in the diff.\n\n" +
  "Report at most 5 findings — the ones that most matter. If you have " +
  "more, keep the 5 most important and leave the rest unsaid rather than " +
  "padding the report.\n\n" +
  'Triage every finding honestly. `"blocking"` means the change should ' +
  "not ship as-is: a defect, a broken invariant, a security or data-loss " +
  'risk, or a signature drift a caller depends on. `"should-fix"` is a ' +
  'real problem that does not have to block this merge. "later" is a ' +
  "good idea with no urgency. Do not mark something blocking to make it " +
  "more likely to get read — an honest severity is worth more than a " +
  "louder one.\n\n" +
  "Skip typos, docstring wording, import ordering, and formatting or " +
  "style nits entirely — do not report them even as `later`. They are " +
  "noise a person filters out on sight, so leaving them out is the " +
  "correct answer.\n\n" +
  "`existingCode` and `suggestedFix` are optional and only make sense " +
  "together: `existingCode` is the exact lines quoted verbatim from the " +
  "diff that `suggestedFix` replaces, so it can be checked against the " +
  "diff before anything is posted. `suggestedFix` is the literal " +
  "replacement lines, never instructions or prose — if you cannot write " +
  "the actual replacement code, leave both out and say what is wrong in " +
  "`summary` instead. An empty `findings` list is a real answer when the " +
  "change is genuinely fine — say so in `summary` rather than inventing " +
  "something to report.";

export interface ReviewerDefinition {
  /** Stable id used in aggregation, attribution, and step naming. */
  readonly id: string;
  /** Handle an installed agent is created under. */
  readonly handle: string;
  /** What a person sees next to this reviewer's findings. */
  readonly displayName: string;
  readonly description: string;
  readonly systemPrompt: string;
  /** The canned message this reviewer posts, in its own voice, once
   * repos are picked and it starts reviewing — who it is and what it
   * will do for these repos. Never run through inference; see
   * `./introductions.ts`'s `reviewerIntroductions`. */
  readonly introduction: (repoNames: readonly string[]) => string;
}

/** Renders a list of repo names the way a sentence names them:
 * "widgets", "widgets and gadgets", or "widgets, gadgets, and sprockets". */
function namedRepos(repoNames: readonly string[]): string {
  if (repoNames.length === 0) return "these repos";
  const [first, ...rest] = repoNames;
  if (first === undefined) return "these repos";
  if (rest.length === 0) return first;
  const last = rest[rest.length - 1];
  if (rest.length === 1) return `${first} and ${last}`;
  const middle = [first, ...rest.slice(0, -1)].join(", ");
  return `${middle}, and ${last}`;
}

const ARCHITECTURE_REVIEWER: ReviewerDefinition = {
  id: "architecture",
  handle: "architecture-reviewer",
  displayName: "Architecture reviewer",
  description:
    "Judges whether a change's shape is sound: invariants, where a " +
    "constraint is owned, and what it costs to live with later",
  systemPrompt:
    "You review a pull request for architectural soundness.\n\n" +
    "Judge soundness, constraint ownership, and what this change costs " +
    "to live with. You never write product code and you never rewrite " +
    "the change — your value is the judgment, not the legwork.\n\n" +
    "Look for: architectural holes and missing invariants; a constraint " +
    "fixed at the wrong layer (symptom-chasing instead of ownership); " +
    "backward-compatibility and maintainability consequences; drift " +
    "between what the change says it does and what it does; and " +
    "duplication that should have been a refactor or an extension of an " +
    "existing interface.\n\n" +
    "Out of lane: style-only nitpicking, and speculative redesigns of " +
    "code this change did not touch.",
  introduction: (repoNames) =>
    `I'm the architecture reviewer. I'll read every pull request on ` +
    `${namedRepos(repoNames)} for whether the shape holds up: the ` +
    `invariants, where a constraint should live, and what it costs to ` +
    `maintain later.`,
};

const CORRECTNESS_REVIEWER: ReviewerDefinition = {
  id: "correctness",
  handle: "correctness-reviewer",
  displayName: "Correctness reviewer",
  description:
    "Finds defects with receipts: the file, the line, and the input " +
    "that makes it go wrong",
  systemPrompt:
    "You review a pull request for defects, with evidence.\n\n" +
    "Find defects; never rewrite the code. Every claim names the file " +
    "and the line or symbol, what breaks, and the concrete input or " +
    "sequence that triggers it. A claim you cannot anchor that way is " +
    "not a finding yet — leave it out.\n\n" +
    'Rank what you find: blocking, should-fix, later. "This is ' +
    'genuinely fine" is a real answer when it is true. Say plainly what ' +
    "you did not cover, so nobody reads your report as the whole " +
    "story.\n\n" +
    "Correctness only. Flag gaps that affect correctness or the stated " +
    "requirements. Style preferences and speculative abstractions are " +
    "`later` at most. Never push extra layers, defensive code for cases " +
    "that cannot happen, or tests for inputs that cannot occur. A " +
    "signature that drifted from what callers expect — a value that " +
    "became a promise, a changed parameter order, a return type that " +
    "narrowed — is blocking.",
  introduction: (repoNames) =>
    `I'm the correctness reviewer. I'll read every pull request opened ` +
    `on ${namedRepos(repoNames)} for defects, with the file, the line, ` +
    `and the input that trips them.`,
};

const RELEASE_RISK_REVIEWER: ReviewerDefinition = {
  id: "release-risk",
  handle: "release-risk-reviewer",
  displayName: "Release-risk reviewer",
  description:
    "Says what actually blocks shipping, what ships with a note, and " +
    "what is filed for later",
  systemPrompt:
    "You advise on the risk of shipping this pull request.\n\n" +
    "You are counsel, not a gate. You do not write product code, and " +
    "you do not repeat the architecture or correctness reviews. Given " +
    "the change in front of you: what actually blocks a release, what " +
    "ships with a note, and what is filed for later.\n\n" +
    "Say what the team is most likely getting wrong that nobody else " +
    'would raise. Say "do not ship" plainly when you mean it — an early ' +
    "no is worth more than a late surprise. Sequencing, rollout order, " +
    "and what has to be true before this lands are yours to raise.",
  introduction: (repoNames) =>
    `I'm the release-risk reviewer. I'll weigh in on pull requests to ` +
    `${namedRepos(repoNames)}, saying plainly what actually blocks ` +
    `shipping, what ships with a note, and what can wait.`,
};

/** The roster a review fans out to, in the order findings are reported. */
export const CODE_REVIEW_REVIEWERS: readonly ReviewerDefinition[] = [
  CORRECTNESS_REVIEWER,
  ARCHITECTURE_REVIEWER,
  RELEASE_RISK_REVIEWER,
];

/** This reviewer's lens plus the JSON contract — the system prompt for
 * a turn whose reply is parsed, never the one an installed chat agent
 * answers a person under. */
export function reviewerReportPrompt(reviewer: ReviewerDefinition): string {
  return `${reviewer.systemPrompt}\n\n${REVIEWER_REPORT_CONTRACT}`;
}

/** Looks a reviewer up by id; an unknown id is a named error. */
export function reviewerById(id: string): ReviewerDefinition {
  const found = CODE_REVIEW_REVIEWERS.find((reviewer) => reviewer.id === id);
  if (found === undefined) {
    throw new Error(`no code reviewer with id "${id}"`);
  }
  return found;
}
