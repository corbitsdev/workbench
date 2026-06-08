/// <reference types="bun" />
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Register a DOM before any testing-library module evaluates: @testing-library/dom
// binds `screen` to document.body at import time, and user-event prepares the
// document at import time, so both must load only after registration. We import
// them dynamically below for that reason.
if (!globalThis.document) {
  GlobalRegistrator.register();
}

import { describe, expect, it, mock } from 'bun:test';

const { render, screen } = await import('@testing-library/react');
const userEvent = (await import('@testing-library/user-event')).default;
const { LoginView } = await import('./LoginView');
const { OnboardingView } = await import('./OnboardingView');
import type { LoginFormState } from './types';

const idle: LoginFormState = { loading: false, error: null };

describe('LoginView', () => {
  it('renders the default Google provider button', () => {
    render(<LoginView state={idle} onOAuth={() => {}} />);
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeDefined();
  });

  it('invokes onOAuth with the provider id when clicked', async () => {
    const user = userEvent.setup();
    const onOAuth = mock((_provider: string) => {});

    render(<LoginView state={idle} onOAuth={onOAuth} />);
    await user.click(screen.getByRole('button', { name: /continue with google/i }));

    expect(onOAuth).toHaveBeenCalledTimes(1);
    expect(onOAuth).toHaveBeenCalledWith('google');
  });

  it('shows the error message when present', () => {
    render(<LoginView state={{ loading: false, error: 'Nope' }} onOAuth={() => {}} />);
    expect(screen.getByText('Nope')).toBeDefined();
  });

  it('disables the button and shows redirecting label while loading', () => {
    render(<LoginView state={{ loading: true, error: null }} onOAuth={() => {}} />);
    const button = screen.getByRole('button');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Redirecting…')).toBeDefined();
  });
});

describe('OnboardingView', () => {
  it('reports name edits and submit intent', async () => {
    const user = userEvent.setup();
    const onNameChange = mock((_name: string) => {});
    const onSubmit = mock(() => {});

    render(
      <OnboardingView
        state={{ name: 'Acme', loading: false, error: null }}
        onNameChange={onNameChange}
        onSubmit={onSubmit}
      />
    );

    await user.type(screen.getByLabelText('Workbench name'), 'X');
    expect(onNameChange).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /create workbench/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('disables submit when the name is empty', () => {
    render(
      <OnboardingView
        state={{ name: '   ', loading: false, error: null }}
        onNameChange={() => {}}
        onSubmit={() => {}}
      />
    );
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
