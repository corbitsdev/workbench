import type { CollateralType } from '@gtm/workbench-shared';

interface CollateralBodyProps {
  body: string;
  type: CollateralType;
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

    if (line.startsWith('## ')) {
      elements.push(
        <h3 key={i} className="text-base font-bold text-gray-900 mt-5 mb-2">
          {line.slice(3)}
        </h3>
      );
    } else if (line.startsWith('# ')) {
      elements.push(
        <h2 key={i} className="text-lg font-bold text-gray-900 mt-4 mb-2">
          {line.slice(2)}
        </h2>
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
            <li key={j} className="text-gray-700 text-sm">
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
        <p key={i} className="text-gray-700 text-sm leading-relaxed mb-3">
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
    <div className="font-mono text-sm text-gray-800 leading-relaxed whitespace-pre-wrap bg-white rounded border border-gray-100 p-5">
      {body}
    </div>
  );
}

function LinkedInBody({ body }: { body: string }) {
  return (
    <div className="bg-white rounded border border-gray-200 p-5">
      <div className="flex items-center gap-3 mb-4 pb-4 border-b border-gray-100">
        <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-xs font-bold">
          YOU
        </div>
        <div>
          <div className="text-sm font-semibold text-gray-900">Your Name</div>
          <div className="text-xs text-gray-500">Your Title · 1st</div>
        </div>
      </div>
      <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{body}</p>
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
          <tr className="bg-gray-50 border-b border-gray-200">
            {headers.map((h, i) => (
              <th
                key={i}
                className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase tracking-wide"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-3 text-gray-700 align-top">
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
  return <p className="text-sm text-gray-700 whitespace-pre-wrap">{body}</p>;
}

export default function CollateralBody({ body, type }: CollateralBodyProps) {
  switch (type) {
    case 'email':
      return <EmailBody body={body} />;
    case 'linkedin':
      return <LinkedInBody body={body} />;
    case 'one-pager':
      return <OnePagerBody body={body} />;
    case 'battlecard':
      return <BattlecardBody body={body} />;
  }
}
