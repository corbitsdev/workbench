// A review that reacts to a bot's own pull request risks a loop: the
// bot pushes, the review posts, something reacts to the posted review,
// and the cycle repeats with no human in it. The guard is a pure
// predicate on the author's login so the workflow entry can skip the
// run before any inference or posting happens.
const BOT_LOGIN_INDICATORS = ["bot_", "bot-", "_bot", "-bot", "[bot]"];

/** Whether a pull-request author's login reads as a bot, not a person. */
export function isBotAuthor(login: string): boolean {
  const normalized = login.toLowerCase();
  return BOT_LOGIN_INDICATORS.some((indicator) =>
    normalized.includes(indicator),
  );
}
