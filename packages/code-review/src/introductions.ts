// The canned copy each reviewer posts once repos are picked and it
// starts reviewing — the identity beat of the first minute. Pure
// formatting over `./reviewers.ts`'s own `introduction` templates; no
// inference runs to produce these, exactly like `@corbits/chat`'s
// `postCannedGreeting`.
import { CODE_REVIEW_REVIEWERS } from "./reviewers";

export interface ReviewerIntroduction {
  readonly handle: string;
  readonly text: string;
}

/** One introduction per reviewer, in `CODE_REVIEW_REVIEWERS` order. */
export function reviewerIntroductions(
  repoNames: readonly string[],
): readonly ReviewerIntroduction[] {
  return CODE_REVIEW_REVIEWERS.map((reviewer) => ({
    handle: reviewer.handle,
    text: reviewer.introduction(repoNames),
  }));
}
