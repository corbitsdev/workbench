import { useState } from 'react';
import { Link } from 'react-router';
import {
  SettingsPage,
  type SettingsFieldValue,
  type SettingsSectionDescriptor,
  type SettingsValues,
} from '@workbench/settings';
import { useTheme } from '@workbench/ui';
import { api } from '../lib/api';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const SECTIONS: readonly SettingsSectionDescriptor[] = [
  {
    id: 'profile',
    title: 'Profile',
    description: 'How you appear across the workbench.',
    fields: [{ key: 'displayName', label: 'Display name', kind: 'text', placeholder: 'Your name' }],
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
        options: [
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ],
      },
    ],
  },
];

const INITIAL_VALUES: SettingsValues = {
  displayName: '',
  emailNotifications: false,
  theme: 'system',
};

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const [values, setValues] = useState<SettingsValues>({ ...INITIAL_VALUES, theme });
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [savedDisplayName, setSavedDisplayName] = useState<string>('');

  const handleChange = (key: string, value: SettingsFieldValue) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    if (key === 'theme' && (value === 'light' || value === 'dark')) {
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
      <div className="mx-auto w-full max-w-2xl px-4 pt-8 pb-2 space-y-3">
        <Link
          to="/settings/credentials"
          className="flex items-center justify-between rounded-xl border border-border bg-surface px-5 py-4 transition-colors hover:bg-surface-2"
        >
          <div>
            <p className="text-[14px] font-medium text-text-1">Credentials</p>
            <p className="mt-0.5 text-[12px] text-text-3">Manage LLM API keys for your agents.</p>
          </div>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-text-3">
            <path
              d="M6 4l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>

      </div>
      <SettingsPage
        sections={SECTIONS}
        values={values}
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
