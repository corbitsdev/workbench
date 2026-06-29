import { ComparisonView, parseComparisonResult } from "@workbench/ui";
import { MarkdownBlock } from "./Markdown";

// The A/B comparison artifact `content` is the JSON string of a ComparisonResult.
// Parse it through the shared schema and render the branded comparison view; on a
// malformed payload fall back to the raw markdown so the page never crashes.
export default function CompareBody({ content }: { content: string }) {
  const result = parseComparisonResult(content);
  if (result !== null) {
    return <ComparisonView result={result} />;
  }
  return (
    <div className="prose prose-sm max-w-[68ch]">
      <MarkdownBlock text={content} />
    </div>
  );
}
