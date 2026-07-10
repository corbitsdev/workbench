import { formatNumber, HudCard } from "./stats";
import { humanizeKey } from "./metrics";

export function CountTable({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; count: number }[];
}) {
  return (
    <HudCard label={title}>
      {rows.length === 0 ? (
        <p className="text-[13px] text-text-3">None recorded</p>
      ) : (
        <table className="w-full text-left text-[13px]">
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="py-1.5 text-[12px] text-text-2">
                  {humanizeKey(row.key)}
                </td>
                <td className="py-1.5 text-right font-mono text-[12px] tabular-nums text-text">
                  {formatNumber(row.count)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </HudCard>
  );
}
