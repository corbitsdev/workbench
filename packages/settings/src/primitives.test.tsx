/// <reference types="bun" />
import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { Select, TextInput, Toggle } from './primitives';

describe('TextInput', () => {
  it('forwards value and change events', () => {
    const onChange = mock(() => {});
    render(
      React.createElement(TextInput, {
        'aria-label': 'name',
        value: 'hi',
        onChange,
        readOnly: true,
      })
    );
    const input = screen.getByLabelText('name') as HTMLInputElement;
    expect(input.value).toBe('hi');
    fireEvent.change(input, { target: { value: 'bye' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('Toggle', () => {
  it('emits the negated checked value on click', () => {
    const onCheckedChange = mock((_v: boolean) => {});
    render(React.createElement(Toggle, { checked: false, onCheckedChange, 'aria-label': 'flag' }));
    const button = screen.getByRole('switch', { name: 'flag' });
    expect(button.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(button);
    expect(onCheckedChange.mock.calls[0]).toEqual([true]);
  });

  it('reflects the checked state and renders disabled', () => {
    const onCheckedChange = mock((_v: boolean) => {});
    render(
      React.createElement(Toggle, {
        checked: true,
        onCheckedChange,
        disabled: true,
        id: 'flag-toggle',
        'aria-label': 'flag',
      })
    );
    const button = screen.getByRole('switch', { name: 'flag' }) as HTMLButtonElement;
    expect(button.getAttribute('aria-checked')).toBe('true');
    expect(button.id).toBe('flag-toggle');
    expect(button.disabled).toBe(true);
  });
});

describe('Select', () => {
  it('renders options and forwards the chosen value', () => {
    const onChange = mock(() => {});
    render(
      React.createElement(
        Select,
        { 'aria-label': 'pick', value: 'a', onChange },
        React.createElement('option', { value: 'a' }, 'A'),
        React.createElement('option', { value: 'b' }, 'B')
      )
    );
    const select = screen.getByLabelText('pick') as HTMLSelectElement;
    expect(select.value).toBe('a');
    fireEvent.change(select, { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
