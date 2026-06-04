/// <reference types="bun" />
import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { SettingsPage } from './SettingsPage';
import { type SettingsSectionDescriptor, type SettingsValues } from './types';

const sections: readonly SettingsSectionDescriptor[] = [
  {
    id: 'profile',
    title: 'Profile',
    description: 'Your account details',
    fields: [
      { key: 'displayName', label: 'Display name', kind: 'text', placeholder: 'Jane Doe' },
      { key: 'emailNotifications', label: 'Email notifications', kind: 'toggle' },
      {
        key: 'theme',
        label: 'Theme',
        kind: 'select',
        options: [
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ],
      },
    ],
  },
];

const values: SettingsValues = {
  displayName: 'Jane',
  emailNotifications: false,
  theme: 'light',
};

describe('SettingsPage', () => {
  it('renders the section title, description, and all field labels', () => {
    render(React.createElement(SettingsPage, { sections, values, onChange: () => {} }));

    expect(screen.getByText('Profile')).toBeDefined();
    expect(screen.getByText('Your account details')).toBeDefined();
    expect(screen.getByText('Display name')).toBeDefined();
    expect(screen.getByText('Email notifications')).toBeDefined();
    expect(screen.getByText('Theme')).toBeDefined();
  });

  it('renders the default page title', () => {
    render(React.createElement(SettingsPage, { sections, values, onChange: () => {} }));
    expect(screen.getByText('Settings')).toBeDefined();
  });

  it('fires onChange with the new string value when a text field changes', () => {
    const onChange = mock((_key: string, _value: string | boolean) => {});
    render(React.createElement(SettingsPage, { sections, values, onChange }));

    const input = screen.getByLabelText('Display name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Janet' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]).toEqual(['displayName', 'Janet']);
  });

  it('fires onChange with the toggled boolean value when a toggle is clicked', () => {
    const onChange = mock((_key: string, _value: string | boolean) => {});
    render(React.createElement(SettingsPage, { sections, values, onChange }));

    const toggle = screen.getByRole('switch', { name: 'Email notifications' });
    fireEvent.click(toggle);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]).toEqual(['emailNotifications', true]);
  });

  it('fires onChange with the selected value when a select field changes', () => {
    const onChange = mock((_key: string, _value: string | boolean) => {});
    render(React.createElement(SettingsPage, { sections, values, onChange }));

    const select = screen.getByLabelText('Theme') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'dark' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]).toEqual(['theme', 'dark']);
  });
});
