import { ComparisonView, Markdown, parseComparisonResult } from "@workbench/ui";
import type { SessionStatus } from "@workbench/shared";
import { EmptyContentNotice } from "./ArtifactContentNotice";

// The A/B comparison artifact `content` is the JSON string of a ComparisonResult.
// Parse it through the shared schema and render the branded comparison view; on a
// malformed payload fall back to the raw markdown so the page never crashes.
export default function CompareBody({
  content,
  layout = "inline",
  sessionStatus,
}: {
  content: string;
  layout?: "inline" | "detail";
  sessionStatus?: SessionStatus | null;
}) {
  if (content.trim().length === 0) {
    return <EmptyContentNotice sessionStatus={sessionStatus} />;
  }
  const result = parseComparisonResult(content);
  if (result !== null) {
    return <ComparisonView result={result} status="final" />;
  }
  const prose = layout === "detail" ? "max-w-none w-full" : "max-w-[68ch]";
  return <Markdown className={prose}>{content}</Markdown>;
}
