// Selectable card grid used by guided dialogs (grant effect, credential
// provider, workbench type, workbench kind). Mirrors the KindCardGrid shape
// from `@corbits/react-ui` so the dialogs keep working when the pin lags
// the component export — styling lives in styles.css.

import type { ReactNode } from "react";

export type KindCardOption = {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
};

export function KindCards({
  options,
  value,
  onChange,
  label,
  columns = 2,
}: {
  readonly options: readonly KindCardOption[];
  readonly value?: string;
  readonly onChange?: (id: string) => void;
  readonly label: string;
  readonly columns?: 2 | 3;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={
        columns === 3 ? "settings-kind-grid cols-3" : "settings-kind-grid"
      }
    >
      {options.map((option) => {
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            disabled={option.disabled === true}
            onClick={() => onChange?.(option.id)}
            className="settings-kind-card"
          >
            {option.icon === undefined ? null : (
              <span className="settings-kind-card-icon" aria-hidden>
                {option.icon}
              </span>
            )}
            <span className="settings-kind-card-title">{option.title}</span>
            {option.description === undefined ? null : (
              <span className="settings-kind-card-desc">
                {option.description}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
