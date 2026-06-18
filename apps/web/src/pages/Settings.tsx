import { useState } from 'react';
import {
  SettingsPage,
  type SettingsFieldValue,
  type SettingsSectionDescriptor,
  type SettingsValues,
} from '@workbench/settings';
import { isTheme, useTheme, THEMES, THEME_LABELS } from '@workbench/ui';
import { api } from '../lib/api';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const SECTIONS: readonly SettingsSectionDescriptor[] = [
  {
    id: 'profile',
    title: 'Profile',
    description: 'How you appear across the workbench.',
    fields: [
      {
        key: 'displayName',
        label: 'Display name',
        kind: 'text',
        placeholder: 'Your name',
      },
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    fields: [
      {
        key: 'emailNotifications',
        label: 'Email notifications',
        kind: 'toggle',
        description: 'Receive a summary when a workflow finishes.',
      },
    ],
  },
  {
    id: 'appearance',
    title: 'Appearance',
    fields: [
      {
        key: 'theme',
        label: 'Theme',
        kind: 'select',
        options: THEMES.map((t) => ({ value: t, label: THEME_LABELS[t] })),
      },
    ],
  },
];

const INITIAL_VALUES: SettingsValues = {
  displayName: '',
  emailNotifications: false,
};

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const [values, setValues] = useState<SettingsValues>({ ...INITIAL_VALUES });
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [savedDisplayName, setSavedDisplayName] = useState<string>('');

  const handleChange = (key: string, value: SettingsFieldValue) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    if (key === 'theme' && isTheme(value)) {
      setTheme(value);
    }
    if (key === 'displayName') {
      setSaveState('idle');
    }
  };

  const displayNameDirty =
    typeof values.displayName === 'string' && values.displayName !== savedDisplayName;

  const handleSaveDisplayName = async () => {
    const name = typeof values.displayName === 'string' ? values.displayName.trim() : '';
    if (!name) return;
    setSaveState('saving');
    try {
      await api('PATCH', '/me/profile', { displayName: name });
      setSavedDisplayName(name);
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <SettingsPage
        sections={SECTIONS}
        values={{ ...values, theme }}
        onChange={handleChange}
        description="Manage your workbench preferences."
      />
      {displayNameDirty && (
        <div className="mx-auto w-full max-w-2xl px-4 pb-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSaveDisplayName}
              disabled={saveState === 'saving'}
              className="rounded-lg bg-orange px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-deep disabled:opacity-50"
            >
              {saveState === 'saving' ? 'Saving…' : 'Save display name'}
            </button>
            {saveState === 'error' && (
              <span className="text-sm text-red-500">Failed to save. Please try again.</span>
            )}
          </div>
        </div>
      )}
      {saveState === 'saved' && (
        <div className="mx-auto w-full max-w-2xl px-4 pb-4">
          <p className="text-sm text-green-600">Display name saved.</p>
        </div>
      )}
    </div>
  );
}
