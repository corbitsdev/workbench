export interface IntakeFormProps {
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}
