export const PEOPLE_EMAIL_REVEAL_CREDITS_PER_PERSON = 1;

export function estimatePeopleEmailRevealCredits(personCount: number): number {
  if (!Number.isFinite(personCount) || personCount < 0) {
    throw new Error("personCount must be a non-negative number");
  }
  return Math.ceil(personCount) * PEOPLE_EMAIL_REVEAL_CREDITS_PER_PERSON;
}
