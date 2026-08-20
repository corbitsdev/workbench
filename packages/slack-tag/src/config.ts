// Parsed at the trust boundary between the host's environment and this
// package: `mountWorkbenchSlack` never trusts a bare `{ botToken,
// signingSecret }` object shape-checked only by TypeScript — an empty
// string (a misconfigured `.env`) would otherwise reach `corbits-tag/slack`
// and fail confusingly deep inside signature verification instead of
// here, at the mount boundary, with a clear message.
import { type } from "arktype";

export const SlackCredentials = type({
  botToken: "string > 0",
  signingSecret: "string > 0",
});

export type SlackCredentialsT = typeof SlackCredentials.infer;

export function parseSlackCredentials(value: unknown): SlackCredentialsT {
  const parsed = SlackCredentials(value);
  if (parsed instanceof type.errors) {
    throw new Error(
      `@corbits/slack-tag: invalid Slack credentials: ${parsed.summary}`,
    );
  }
  return parsed;
}
