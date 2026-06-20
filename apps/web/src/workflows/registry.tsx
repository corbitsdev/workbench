// Contract each workflow package must satisfy when exporting intake UI.
// The hub supplies deployed kind strings at runtime; apps/web lazy-loads
// the matching package via workflow-ui.ts and renders IntakeForm if present.

export interface IntakeFormProps {
  // Called with the trigger payload when the user submits the form.
  // The promise resolves after the run has been started.
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}
