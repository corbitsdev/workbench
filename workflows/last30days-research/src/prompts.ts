export function buildIntentSystemPrompt(): string {
  return `You normalize last30days research requests.

Return strict JSON only, with this shape:
{
  "topic": "normalized research topic",
  "days": 30,
  "queryType": "GENERAL" | "NEWS" | "COMPARISON" | "RECOMMENDATIONS",
  "comparisonEntities": ["entity A", "entity B"],
  "outcomeCategory": "optional recommendation target",
  "sourceHints": {
    "includeYoutube": true,
    "includeBluesky": true,
    "includePolymarket": false,
    "includeCreatorPlatforms": false
  },
  "queries": {
    "core": "broad search query",
    "hackernews": "HN query",
    "github": "GitHub query",
    "web": "web query",
    "reddit": "Reddit query",
    "x": "X query",
    "youtube": "YouTube query",
    "bluesky": "Bluesky query"
  }
}

Rules:
- Do not ask questions. If the request is broad, choose the most useful normalized topic.
- Use days from the user when explicit, otherwise 30.
- Keep query strings short and source-appropriate.
- Set optional source hints based on relevance, but core sources always run downstream.`;
}

export function buildWriterSystemPrompt(): string {
  return `You write grounded last30days research reports from a structured brief.

Input includes the intake topic and a deterministic brief tool result. The brief is JSON in the tool result's content field and has stats, clusters, bestTakes, items, and citations.
Return markdown only. Do not wrap it in JSON.

Writing rules:
- Write from the brief only. Do not invent claims, numbers, citations, or sources.
- Start with: "What I learned about [topic]:" followed by the lead insight or top cluster.
- Include a stats line: "**N sources · N items · date range**".
- Use narrative prose, not bullet lists.
- Every substantive claim needs an inline markdown link from brief.citations.
- Integrate 2-3 strong bestTakes when available.
- End with: "*Research by last30days via GTM Workbench*".
- Avoid em dashes.
- If the brief is sparse, say what was and was not found instead of padding.`;
}

export function buildRepairSystemPrompt(): string {
  return `You repair a last30days report that failed validation.

Input is JSON containing { intent, draft, validation, brief }.
Return strict JSON only with the same shape as the writer step:
{
  "title": "artifact title",
  "body": "markdown report body",
  "citations": [...brief.citations],
  "data": brief
}

Fix only the cited validation issues. Keep all claims grounded in the brief and citations.`;
}
