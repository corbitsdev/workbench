// The one shared seam every eval-side model call goes through — a small
// POST to the Anthropic Messages API. `judge()` (scorers/scorers.ts) and
// `personaAnswer()` (persona.ts) both call this instead of inlining
// `fetch`, so there is exactly one place that knows the wire format.

export interface ModelCallResult {
  readonly text: string;
}

const DEFAULT_MODEL = "claude-3-5-haiku-20241022";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function callEvalModel(
  prompt: string,
  apiKey: string,
  model = DEFAULT_MODEL,
  fetchImpl: FetchLike = fetch,
): Promise<ModelCallResult> {
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
  };
  const text = data.content?.find((block) => block.type === "text")?.text ?? "";
  return { text };
}
