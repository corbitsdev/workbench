// Settings sections are quiet rows under a heading, not cards or tables.

import type { ReactNode } from "react";

import "./rows.css";

export function SettingsGroup({
  title,
  description,
  action,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="settings-group">
      <header className="settings-group-head">
        <div>
          <h2 className="settings-group-title">{title}</h2>
          {description !== undefined ? <p className="settings-group-lede">{description}</p> : null}
        </div>
        {action}
      </header>
      <div className="settings-rows">{children}</div>
    </section>
  );
}

export function SettingsRow({
  title,
  meta,
  actions,
}: {
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-main">
        <span className="settings-row-title">{title}</span>
        {meta !== undefined ? <span className="settings-row-meta">{meta}</span> : null}
      </div>
      {actions !== undefined ? <div className="settings-row-actions">{actions}</div> : null}
    </div>
  );
}

export type SegmentedOption<T extends string> = { readonly value: T; readonly label: string };

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly SegmentedOption<T>[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <div className="settings-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="settings-seg-option"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
