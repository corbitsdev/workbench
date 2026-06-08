import { type FormEvent } from 'react';
import { Input, Label } from './Field';
import { type OnboardingFormState } from './types';

export interface OnboardingViewProps {
  /** Current form state (name / loading / error). Owned by the consuming app. */
  state: OnboardingFormState;
  /** Invoked with the new value as the user edits the workbench name. */
  onNameChange: (name: string) => void;
  /** Invoked on form submit. The app owns validation and workbench creation. */
  onSubmit: () => void;
}

/**
 * Stateless onboarding (create workbench) presentation. The consuming app owns
 * the name state, validation, and hub-api wiring; this view renders the form
 * and reports name edits and submit intent.
 */
export function OnboardingView({ state, onNameChange, onSubmit }: OnboardingViewProps) {
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  return (
    <div className="flex min-h-svh items-center justify-center bg-surface p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-8">
          <div className="h-7 w-7 rounded bg-orange" />
          <span className="text-lg font-semibold tracking-tight text-text">GTM Workbench</span>
        </div>

        <h1 className="text-2xl font-bold text-text mb-2">Create your workbench</h1>
        <p className="text-sm text-text-2 mb-6">
          Your workbench is where your team's collateral lives. You can invite teammates after
          setup.
        </p>

        {state.error && (
          <p className="rounded-lg border border-orange bg-orange-soft px-3 py-2 text-sm text-orange-deep mb-4">
            {state.error}
          </p>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="workbench-name">Workbench name</Label>
            <Input
              id="workbench-name"
              type="text"
              value={state.name}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="Acme Sales"
              maxLength={100}
              autoFocus
            />
          </div>

          <button
            type="submit"
            disabled={state.loading || state.name.trim().length === 0}
            className="w-full rounded-md bg-orange px-4 py-2 text-sm font-medium text-text hover:bg-orange-deep disabled:opacity-50"
          >
            {state.loading ? 'Creating workbench…' : 'Create workbench'}
          </button>
        </form>
      </div>
    </div>
  );
}
