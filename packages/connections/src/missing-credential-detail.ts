// The wire shape a `ToolResult.detail` carries when a tool call didn't
// run because a connector's credential isn't connected — the mid-turn
// counterpart to `MissingCredentialError`'s launch-time halt. A plain,
// `kind`-discriminated value rather than the error class itself: this
// travels the same sidecar event wire every other `ToolResult` does, so
// it's parsed here rather than trusted, matching every other external
// boundary in this repo. A tool package that wants the chat to render
// the connect-service card writes this shape onto its `ToolResult`
// literally (no dependency on this package needed to produce it — only
// the reader, `@corbits/chat`'s orchestrator, needs to parse it).
import { type } from "arktype";

export const MissingCredentialDetail = type({
  kind: "'missing-credential'",
  connectorId: "string > 0",
});
export type MissingCredentialDetail = typeof MissingCredentialDetail.infer;

export function missingCredentialDetail(
  connectorId: string,
): MissingCredentialDetail {
  return { kind: "missing-credential", connectorId };
}

export function parseMissingCredentialDetail(
  detail: unknown,
): MissingCredentialDetail | undefined {
  const parsed = MissingCredentialDetail(detail);
  return parsed instanceof type.errors ? undefined : parsed;
}
