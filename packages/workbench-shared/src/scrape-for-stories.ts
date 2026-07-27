import { type } from "arktype";

const NonEmptyText = type("string").narrow((value) => value.trim().length > 0);

// Resume-boundary contract for the scrape-for-stories workflow's `intake` gate
// (CL-4430). The gate is filled by the schedule, not a person at run time, so a
// hollow payload has no human to notice it: the collect agent would search
// nothing and still persist a "thin week" bucket that Daily LinkedIn then reads
// as the truth. Requiring at least one non-blank topic rejects that at /resume
// instead of quietly shipping an empty bucket downstream.
export const ScrapeForStoriesIntakePayloadSchema = type({
  topics: NonEmptyText.array().atLeastLength(1),
});
export type ScrapeForStoriesIntakePayload =
  typeof ScrapeForStoriesIntakePayloadSchema.infer;
