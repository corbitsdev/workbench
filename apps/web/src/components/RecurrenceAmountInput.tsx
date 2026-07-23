import { useState } from "react";

export type RecurrenceAmountInputProps = {
  /** The committed amount (the source of truth, from the parent's recurrence). */
  amount: number;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className: string;
  /** Called only with a valid whole number >= 1 — never with NaN/0/negative. */
  onCommit: (amount: number) => void;
};

/**
 * A recurrence "how often" amount input (CL-4278 review fix #2/#3).
 *
 * Two failure modes a plain `<input type="number" value={amount} onChange=...>`
 * has when the `onChange` guard rejects the typed value (empty, `0`, a
 * negative number): the guard's early return means `onRecurrenceChange` is
 * never called, so the parent's `amount` prop never changes, so React never
 * re-renders this input, so the DOM value is left at whatever invalid text the
 * user typed with no feedback that anything failed. This component instead
 * tracks the raw typed text as local state — always shown, valid or not — and
 * only forwards a value to `onCommit` when it parses to a whole number >= 1.
 * An invalid draft shows a visible message inline and is discarded on blur
 * back to the last committed amount, so the control never silently no-ops.
 *
 * `step={1}` (fix #3) keeps the native stepper/validation from ever landing
 * on a fractional value — `intervalFromAmountUnit` rounds a fractional amount
 * silently, so the control itself must not be able to express one.
 */
export function RecurrenceAmountInput({
  amount,
  id,
  ariaLabel,
  disabled = false,
  className,
  onCommit,
}: RecurrenceAmountInputProps) {
  const [draft, setDraft] = useState(() => String(amount));
  const [syncedAmount, setSyncedAmount] = useState(amount);
  const [invalid, setInvalid] = useState(false);

  // Derived-state-from-props without an effect: when the committed amount
  // changes for a reason other than this input's own edit (unit switch,
  // reopening the editor on a different schedule), resync the draft.
  if (amount !== syncedAmount) {
    setSyncedAmount(amount);
    setDraft(String(amount));
    setInvalid(false);
  }

  const handleChange = (value: string) => {
    setDraft(value);
    const parsed = Number(value);
    const valid =
      value.trim() !== "" && Number.isInteger(parsed) && parsed >= 1;
    setInvalid(!valid);
    if (valid) onCommit(parsed);
  };

  const handleBlur = () => {
    if (invalid) {
      setDraft(String(amount));
      setInvalid(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <input
        id={id}
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        aria-label={ariaLabel}
        aria-invalid={invalid}
        disabled={disabled}
        value={draft}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        className={className}
      />
      {invalid ? (
        <span className="text-[11px] text-danger" role="alert">
          Enter a whole number, 1 or more.
        </span>
      ) : null}
    </div>
  );
}
