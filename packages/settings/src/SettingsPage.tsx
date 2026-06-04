import { cn } from '@workbench/ui';
import {
  type SettingsChangeHandler,
  type SettingsSectionDescriptor,
  type SettingsValues,
} from './types';
import { SettingsSection } from './SettingsSection';

export interface SettingsPageProps {
  /** Section descriptors rendered top to bottom. */
  readonly sections: readonly SettingsSectionDescriptor[];
  /** Current values for every field. */
  readonly values: SettingsValues;
  /** Called when any field changes. The consumer owns persistence. */
  readonly onChange: SettingsChangeHandler;
  /** Optional page heading. Defaults to "Settings". */
  readonly title?: string;
  /** Optional supporting copy under the heading. */
  readonly description?: string;
  readonly className?: string;
}

export function SettingsPage({
  sections,
  values,
  onChange,
  title = 'Settings',
  description,
  className,
}: SettingsPageProps) {
  return (
    <div className={cn('mx-auto w-full max-w-2xl px-4 py-8', className)}>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text">{title}</h1>
        {description !== undefined && <p className="mt-1 text-sm text-text-2">{description}</p>}
      </header>
      <div className="flex flex-col gap-6">
        {sections.map((section) => (
          <SettingsSection key={section.id} section={section} values={values} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}
