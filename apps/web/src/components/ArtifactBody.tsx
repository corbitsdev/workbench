import PresentationBody from './PresentationBody';

interface ArtifactBodyProps {
  body: string;
  type: string;
}

function parseMarkdownTable(text: string): { headers: string[]; rows: string[][] } | null {
  const lines = text.trim().split('\n');
  const tableLines = lines.filter((l) => l.trim().startsWith('|'));
  if (tableLines.length < 2) return null;

  const parseRow = (line: string) =>
    line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());

  const headers = parseRow(tableLines[0]);
  const rows = tableLines
    .slice(2)
    .filter((l) => !l.match(/^[\s|:-]+$/))
    .map(parseRow);

  return { headers, rows };
}

function MarkdownBlock({ text }: { text: string }) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  const renderInline = (str: string) => {
    const parts = str.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((p, idx) =>
      p.startsWith('**') && p.endsWith('**') ? (
        <strong key={idx}>{p.slice(2, -2)}</strong>
      ) : (
        <span key={idx}>{p}</span>
      )
    );
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('### ')) {
      elements.push(
        <h4 key={i} className="text-sm font-bold text-text mt-4 mb-1.5">
          {line.slice(4)}
        </h4>
      );
    } else if (line.startsWith('## ')) {
      elements.push(
        <h3 key={i} className="text-base font-bold text-text mt-5 mb-2">
          {line.slice(3)}
        </h3>
      );
    } else if (line.startsWith('# ')) {
      elements.push(
        <h2 key={i} className="text-lg font-bold text-text mt-4 mb-2">
          {line.slice(2)}
        </h2>
      );
    } else if (line.startsWith('> ')) {
      elements.push(
        <blockquote
          key={i}
          className="border-l-2 border-border pl-3 italic text-text-3 text-sm my-2"
        >
          {renderInline(line.slice(2))}
        </blockquote>
      );
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      const items: string[] = [];
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('* '))) {
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
        </ul>
      );
      continue;
    } else if (line.trim() === '') {
      // skip blank lines between blocks
    } else {
      elements.push(
        <p key={i} className="text-text-2 text-sm leading-relaxed mb-3">
          {renderInline(line)}
        </p>
      );
    }
    i++;
  }

  return <>{elements}</>;
}

function EmailBody({ body }: { body: string }) {
  return (
    <div className="font-mono text-sm text-text-2 leading-relaxed whitespace-pre-wrap bg-surface-2 rounded border border-border p-5">
      {body}
    </div>
  );
}

function LinkedInBody({ body }: { body: string }) {
  return (
    <div className="bg-surface-2 rounded border border-border p-5">
      <div className="flex items-center gap-3 mb-4 pb-4 border-b border-border">
        <div className="w-10 h-10 rounded-full bg-surface border border-border flex items-center justify-center text-text-3 text-xs font-bold">
          YOU
        </div>
        <div>
          <div className="text-sm font-semibold text-text">Your Name</div>
          <div className="text-xs text-text-3">Your Title · 1st</div>
        </div>
      </div>
      <p className="text-sm text-text-2 leading-relaxed whitespace-pre-wrap">{body}</p>
    </div>
  );
}

function OnePagerBody({ body }: { body: string }) {
  const tableData = parseMarkdownTable(body);
  if (tableData) {
    return <TableBody headers={tableData.headers} rows={tableData.rows} />;
  }
  return (
    <div className="prose prose-sm max-w-none">
      <MarkdownBlock text={body} />
    </div>
  );
}

function TableBody({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-surface-2 border-b border-border-strong">
            {headers.map((h, i) => (
              <th
                key={i}
                className="text-left px-4 py-2 text-xs font-semibold text-text-3 uppercase tracking-wide"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-border hover:bg-surface-2">
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-3 text-text-2 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BattlecardBody({ body }: { body: string }) {
  const tableData = parseMarkdownTable(body);
  if (tableData) {
    return <TableBody headers={tableData.headers} rows={tableData.rows} />;
  }
  return <p className="text-sm text-text-2 whitespace-pre-wrap">{body}</p>;
}

export default function ArtifactBody({ body, type }: ArtifactBodyProps) {
  switch (type) {
    // email
    case 'email':
    case 'follow-up-email':
      return <EmailBody body={body} />;
    // social posts
    case 'linkedin':
    case 'linkedin-post':
    // Legacy rows: pre-unification LinkedIn Daily drafts kept this kind.
    case 'linkedin-daily':
    case 'pain-points-linkedin-post':
    case 'twitter-post':
    case 'pain-points-twitter-post':
    case 'founder-pov-post':
      return <LinkedInBody body={body} />;
    // documents
    case 'one-pager':
    case 'sales-one-pager':
    case 'blog':
    case 'pain-points-blog':
    case 'case-study':
    case 'case-study-draft':
    case 'objection-handling':
    case 'objection-handling-doc':
    case 'customer-quotes':
    case 'customer-quote-pulls':
    case 'pain-points':
    case 'call-transcript':
      return <OnePagerBody body={body} />;
    // battlecard
    case 'battlecard':
      return <BattlecardBody body={body} />;
    // presentation
    case 'presentation': {
      let isValidUrl = false;
      try {
        const parsed = new URL(body);
        isValidUrl = parsed.protocol === 'https:';
      } catch {
        isValidUrl = false;
      }
      if (!isValidUrl) {
        return (
          <p className="text-sm text-text-3 p-4">
            Presentation URL is invalid or unavailable.
          </p>
        );
      }
      return <PresentationBody url={body} />;
    }
    // fallback
    default:
      return <OnePagerBody body={body} />;
  }
}
