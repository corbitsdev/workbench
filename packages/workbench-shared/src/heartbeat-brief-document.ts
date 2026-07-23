/**
 * Composes the morning brief's persisted document from the title step's
 * `title` and the brief agent's `reply` (CL-4232): the single place that
 * turns the agent-`reply` output field into the `body` name a portable
 * `write_artifact` accepts, so downstream persist/notify steps see a plain
 * `{ title, body }` shape instead of reaching into an agent-specific field.
 */
export function formatHeartbeatBriefDocument(
  title: string,
  reply: string,
): { title: string; body: string } {
  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0) {
    throw new Error("title is required to compose the brief document");
  }
  if (reply.trim().length === 0) {
    throw new Error("reply is required to compose the brief document");
  }
  return { title: trimmedTitle, body: reply };
}
