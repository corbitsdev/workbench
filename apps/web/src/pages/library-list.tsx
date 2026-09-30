import type { CSSProperties, ReactNode } from "react";

import "./library-list.css";

export function ListFilter({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <input
      className="lib-filter"
      placeholder={label}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** The raised card: a sunk header row, then the rows. `columns` is the
 * grid-template-columns every row shares. */
export function ListCard({
  label,
  columns,
  heads,
  children,
}: {
  readonly label: string;
  readonly columns: string;
  readonly heads: readonly string[];
  readonly children: ReactNode;
}) {
  return (
    <ul className="lib-list" aria-label={label} style={{ "--lib-cols": columns } as CSSProperties}>
      <li className="lib-head" aria-hidden="true">
        {heads.map((head, index) => (
          <span key={`${head}-${String(index)}`}>{head}</span>
        ))}
      </li>
      {children}
    </ul>
  );
}
