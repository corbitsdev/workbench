// Minimal markdown renderer shared across artifact bodies. Intentionally small —
// it covers the subset our generators emit (headings, bullet lists, blockquotes,
// bold inline) rather than pulling in a full markdown dependency.
export function MarkdownBlock({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  const renderInline = (str: string) => {
    const parts = str.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((p, idx) =>
      p.startsWith("**") && p.endsWith("**") ? (
        <strong key={idx}>{p.slice(2, -2)}</strong>
      ) : (
        <span key={idx}>{p}</span>
      ),
    );
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("### ")) {
      elements.push(
        <h4 key={i} className="text-sm font-bold text-text mt-4 mb-1.5">
          {line.slice(4)}
        </h4>,
      );
    } else if (line.startsWith("## ")) {
      elements.push(
        <h3 key={i} className="text-base font-bold text-text mt-5 mb-2">
          {line.slice(3)}
        </h3>,
      );
    } else if (line.startsWith("# ")) {
      elements.push(
        <h2 key={i} className="text-lg font-bold text-text mt-4 mb-2">
          {line.slice(2)}
        </h2>,
      );
    } else if (line.startsWith("> ")) {
      elements.push(
        <blockquote
          key={i}
          className="border-l-2 border-border pl-3 italic text-text-3 text-sm my-2"
        >
          {renderInline(line.slice(2))}
        </blockquote>,
      );
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      const items: string[] = [];
      while (
        i < lines.length &&
        (lines[i].startsWith("- ") || lines[i].startsWith("* "))
      ) {
        items.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <ul key={`ul-${i}`} className="list-disc list-inside space-y-1 mb-3">
          {items.map((item, j) => (
            <li key={j} className="text-text-2 text-sm">
              {renderInline(item)}
            </li>
          ))}
        </ul>,
      );
      continue;
    } else if (line.trim() === "") {
      // skip blank lines between blocks
    } else {
      elements.push(
        <p key={i} className="text-text-2 text-sm leading-relaxed mb-3">
          {renderInline(line)}
        </p>,
      );
    }
    i++;
  }

  return <>{elements}</>;
}
