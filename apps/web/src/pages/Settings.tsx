import { useState } from 'react';
import {
  SettingsPage,
  type SettingsFieldValue,
  type SettingsSectionDescriptor,
  type SettingsValues,
} from '@workbench/settings';

// Static section descriptors. This route is a scaffold: it proves the
// @workbench/settings package is consumable. Real persistence is out of scope.
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
  const [values, setValues] = useState<SettingsValues>(INITIAL_VALUES);

  const handleChange = (key: string, value: SettingsFieldValue) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="h-full overflow-y-auto">
      <SettingsPage
        sections={SECTIONS}
        values={values}
        onChange={handleChange}
        description="Manage your workbench preferences."
      />
    </div>
  );
}
