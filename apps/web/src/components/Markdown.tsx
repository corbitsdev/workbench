// Small markdown renderer shared across artifact bodies. It covers the subset
// our generators emit — headings, ordered/unordered lists, blockquotes, rules,
// and inline bold/italic/links — with the app's typographic hierarchy applied,
// rather than pulling in a full markdown dependency.

const INLINE_PATTERN = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g;

function renderInline(str: string): React.ReactNode[] {
  return str.split(INLINE_PATTERN).map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={idx} className="font-semibold text-text">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return (
        <em key={idx} className="italic">
          {part.slice(1, -1)}
        </em>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      return (
        <a
          key={idx}
          href={link[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          {link[1]}
        </a>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

export function MarkdownBlock({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("### ")) {
      elements.push(
        <h4 key={i} className="text-sm font-semibold text-text mt-5 mb-2">
          {renderInline(line.slice(4))}
        </h4>,
      );
    } else if (line.startsWith("## ")) {
      elements.push(
        <h3
          key={i}
          className="text-lg font-semibold text-text mt-7 mb-2.5 text-balance"
        >
          {renderInline(line.slice(3))}
        </h3>,
      );
    } else if (line.startsWith("# ")) {
      elements.push(
        <h2
          key={i}
          className="text-xl font-semibold text-text mt-6 mb-3 text-balance"
        >
          {renderInline(line.slice(2))}
        </h2>,
      );
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      elements.push(<hr key={i} className="my-6 border-border" />);
    } else if (line.startsWith("> ")) {
      elements.push(
        <blockquote
          key={i}
          className="border-l-2 border-accent/50 pl-4 italic text-text-2 my-3"
        >
          {renderInline(line.slice(2))}
        </blockquote>,
      );
    } else if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, ""));
        i++;
      }
      elements.push(
        <ol
          key={`ol-${i}`}
          className="list-decimal pl-5 marker:text-text-3 marker:font-medium space-y-2 my-4"
        >
          {items.map((item, j) => (
            <li key={j} className="text-[15px] text-text-2 leading-7 pl-1.5">
              {renderInline(item)}
            </li>
          ))}
        </ol>,
      );
      continue;
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
        <ul
          key={`ul-${i}`}
          className="list-disc pl-5 marker:text-text-3 space-y-1.5 my-4"
        >
          {items.map((item, j) => (
            <li key={j} className="text-[15px] text-text-2 leading-7 pl-1.5">
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
        <p key={i} className="text-[15px] text-text-2 leading-7 mb-4">
          {renderInline(line)}
        </p>,
      );
    }
    i++;
  }

  return <>{elements}</>;
}
