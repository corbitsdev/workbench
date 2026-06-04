import { type ComponentPropsWithoutRef } from 'react';
import { cn } from '@workbench/ui';

/**
 * Minimal stateless form primitives used by settings sections.
 *
 * @workbench/ui intentionally does not export form inputs/toggles, so these
 * live here. They are presentational only: value in, change out.
 */

type TextInputProps = ComponentPropsWithoutRef<'input'>;

export const TextInput = ({ className, ...props }: TextInputProps) => (
  <input
    type="text"
    className={cn(
      'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text',
      'placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-orange',
      'disabled:opacity-50 disabled:cursor-not-allowed',
      className
    )}
    {...props}
  />
);

interface ToggleProps {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly 'aria-label'?: string;
}

export const Toggle = ({ checked, onCheckedChange, disabled, id, ...rest }: ToggleProps) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={rest['aria-label']}
    id={id}
    disabled={disabled}
    onClick={() => onCheckedChange(!checked)}
    className={cn(
      'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
      'focus:outline-none focus:ring-2 focus:ring-orange',
      'disabled:opacity-50 disabled:cursor-not-allowed',
      checked ? 'bg-orange' : 'bg-surface-2 border border-border'
    )}
  >
    <span
      className={cn(
        'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
        checked ? 'translate-x-6' : 'translate-x-1'
      )}
    />
  </button>
);

type SelectProps = ComponentPropsWithoutRef<'select'>;

export const Select = ({ className, children, ...props }: SelectProps) => (
  <select
    className={cn(
      'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text',
      'focus:outline-none focus:ring-2 focus:ring-orange',
      'disabled:opacity-50 disabled:cursor-not-allowed',
      className
    )}
    {...props}
  >
    {children}
  </select>
);
