/** Mirrors the IntakeFormProps contract from apps/web/src/workflows/registry.tsx. */
export interface IntakeFormProps {
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}
