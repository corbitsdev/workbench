// A minimal, dependency-free renderer for the safe markdown subset chat
// messages use: bold, italic, inline code, fenced code blocks, ordered and
// unordered lists, links, and headings (rendered as bold lines rather than
// distinct heading elements, since a chat bubble has no heading hierarchy
// to preserve). Never uses `dangerouslySetInnerHTML` — every character of
// message text passes through React as text content, so raw HTML in a
// message can never execute or render as markup.

import type { ReactNode } from "react";

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let remaining = text;
  let index = 0;

  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\([^)\s]+\))/;

  while (remaining.length > 0) {
    const match = pattern.exec(remaining);
    if (match === null) {
      nodes.push(remaining);
      break;
    }
    const matchIndex = match.index;
    if (matchIndex > 0) nodes.push(remaining.slice(0, matchIndex));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;

    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="chat-md-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("[")) {
      const closeBracket = token.indexOf("]");
      const label = token.slice(1, closeBracket);
      const href = token.slice(closeBracket + 2, -1);
      nodes.push(
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="chat-md-link"
        >
          {label}
        </a>,
      );
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }

    remaining = remaining.slice(matchIndex + token.length);
  }

  return nodes;
}

type Block =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: "heading"; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string };

function parseBlocks(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim().startsWith("```")) {
      const codeLines: string[] = [];
      index++;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index++;
      }
      index++; // consume closing fence
      blocks.push({ kind: "code", code: codeLines.join("\n") });
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch !== null) {
      blocks.push({ kind: "heading", text: headingMatch[2] ?? "" });
      index++;
      continue;
    }

    const bulletMatch = /^\s*[-*]\s+(.*)$/.exec(line);
    const orderedMatch = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bulletMatch !== null || orderedMatch !== null) {
      const ordered = orderedMatch !== null;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const bulletItem = /^\s*[-*]\s+(.*)$/.exec(current);
        const orderedItem = /^\s*\d+\.\s+(.*)$/.exec(current);
        const item = ordered ? orderedItem : bulletItem;
        if (item === null) break;
        items.push(item[1] ?? "");
        index++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (line.trim().length === 0) {
      index++;
      continue;
    }

    const paragraphLines: string[] = [line];
    index++;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim().length > 0 &&
      !/^\s*[-*]\s+/.test(lines[index] ?? "") &&
      !/^\s*\d+\.\s+/.test(lines[index] ?? "") &&
      !/^#{1,6}\s+/.test(lines[index] ?? "") &&
      !(lines[index] ?? "").trim().startsWith("```")
    ) {
      paragraphLines.push(lines[index] ?? "");
      index++;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join("\n") });
  }

  return blocks;
}

/**
 * Renders the safe markdown subset (bold/italic/inline code/code
 * blocks/lists/links/headings-as-bold) message text uses. Plain text with
 * no markdown syntax renders exactly as before — a single paragraph of its
 * own text.
 */
export function Markdown({ text }: { readonly text: string }) {
  const blocks = parseBlocks(text);

  return (
    <>
      {blocks.map((block, blockIndex) => {
        const key = `block-${blockIndex}`;
        if (block.kind === "code") {
          return (
            <pre key={key} className="chat-md-code-block">
              <code>{block.code}</code>
            </pre>
          );
        }
        if (block.kind === "heading") {
          return (
            <p key={key} className="chat-md-heading">
              <strong>{renderInline(block.text, key)}</strong>
            </p>
          );
        }
        if (block.kind === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag key={key} className="chat-md-list">
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>
                  {renderInline(item, `${key}-${itemIndex}`)}
                </li>
              ))}
            </ListTag>
          );
        }
        return (
          <span key={key} className="chat-md-paragraph">
            {renderInline(block.text, key)}
          </span>
        );
      })}
    </>
  );
}
