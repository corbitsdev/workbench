// The same three reviewer definitions, in the shape the agent-directory
// create path takes. Installing them makes each reviewer a real agent in
// the workbench — visible in the directory, addressable on its own — so
// the roster a review fans out to is the roster a person can see and
// edit, not a hidden constant.
import { CODE_REVIEW_REVIEWERS, type ReviewerDefinition } from "./reviewers";

/** One create-agent request; mirrors the create route's own body. */
export interface CodeReviewAgentRequest {
  readonly name: string;
  readonly handle: string;
  readonly description: string;
  readonly systemPrompt: string;
}

function toRequest(reviewer: ReviewerDefinition): CodeReviewAgentRequest {
  return {
    name: reviewer.displayName,
    handle: reviewer.handle,
    description: reviewer.description,
    systemPrompt: reviewer.systemPrompt,
  };
}

/** The create-agent requests that install the reviewer roster. */
export function codeReviewAgentRequests(): readonly CodeReviewAgentRequest[] {
  return CODE_REVIEW_REVIEWERS.map(toRequest);
}
