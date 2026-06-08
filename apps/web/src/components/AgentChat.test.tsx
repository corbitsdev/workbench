/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LaunchInstanceSessionResponse } from '../lib/hub-api';

const mockLaunchInstanceSession = mock<
  (instanceId: string) => Promise<LaunchInstanceSessionResponse>
>(() => Promise.resolve({ launched: false, launchError: 'sidecar not connected' }));
const mockStart = mock(() => () => undefined);
const mockCreateInstanceSession = mock(() => ({
  events: [],
  streaming: '',
  activity: null,
  hydrated: false,
  start: mockStart,
  sendMail: mock(() => Promise.resolve()),
  destroy: mock(() => undefined),
}));

mock.module('../lib/hub-api', () => ({
  launchInstanceSession: mockLaunchInstanceSession,
}));

mock.module('@intx/hub-client', () => ({
  createInstanceSession: mockCreateInstanceSession,
}));

mock.module('../lib/instance-transport', () => ({
  createHubTransport: () => ({}),
}));

import { AgentChat } from './AgentChat';

function renderAgentChat(overrides?: {
  instanceStatus?: string;
  onConfigureAgent?: () => void;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentChat
        instanceId="ins_123"
        tenantId="tnt_123"
        agentName="Loop"
        {...overrides}
      />
    </QueryClientProvider>
  );
}

function renderDeployedAgentChat() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentChat instanceId="ins_deployed" tenantId="tnt_123" agentName="Loop" />
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  mockLaunchInstanceSession.mockClear();
  mockCreateInstanceSession.mockClear();
  mockStart.mockClear();
});

describe('AgentChat — fatal launch error', () => {
  it('does not hydrate a session and shows retry for an unrecognised error', async () => {
    mockLaunchInstanceSession.mockImplementation(() =>
      Promise.resolve({ launched: false, launchError: 'internal server error' })
    );

    const view = renderAgentChat();

    await waitFor(() => {
      expect(view.getByText(/could not be reached/i)).toBeTruthy();
    });

    expect(view.getByText(/try again/i)).toBeTruthy();
    expect(mockCreateInstanceSession).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('attempts to launch deployed agents instead of treating them as dead', async () => {
    mockLaunchInstanceSession.mockImplementationOnce(() => Promise.resolve({ launched: true }));

    renderDeployedAgentChat();

    await waitFor(() => {
      expect(mockLaunchInstanceSession).toHaveBeenCalledWith('ins_deployed');
    });

    expect(mockCreateInstanceSession).toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalled();
  });

  it('does not leak raw error strings to the user', async () => {
    mockLaunchInstanceSession.mockImplementation(() =>
      Promise.resolve({ launched: false, launchError: '502 Bad Gateway' })
    );

    const view = renderAgentChat();

    await waitFor(() => {
      expect(view.getByText(/could not be reached/i)).toBeTruthy();
    });

    expect(view.queryByText(/502 Bad Gateway/)).toBeNull();
  });
});

describe('AgentChat — transient launch errors', () => {
  it('shows a waiting notice for sidecar-not-connected errors instead of an error', async () => {
    mockLaunchInstanceSession.mockImplementation(() =>
      Promise.resolve({ launched: false, launchError: 'No sidecar connected for agent "ins_123"' })
    );

    const view = renderAgentChat();

    await waitFor(() => {
      expect(view.getByText(/waiting for loop to become available/i)).toBeTruthy();
    });

    expect(view.queryByText(/No sidecar connected/)).toBeNull();
    expect(mockCreateInstanceSession).not.toHaveBeenCalled();
  });

  it('shows a waiting notice for sidecar-not-available errors', async () => {
    mockLaunchInstanceSession.mockImplementation(() =>
      Promise.resolve({ launched: false, launchError: 'No sidecar available for agent "ins_123"' })
    );

    const view = renderAgentChat();

    await waitFor(() => {
      expect(view.getByText(/waiting for loop to become available/i)).toBeTruthy();
    });

    expect(view.queryByText(/No sidecar available/)).toBeNull();
  });

  it('shows a waiting notice for legacy sidecar-not-connected messages', async () => {
    // Default mock returns { launchError: 'sidecar not connected' }
    const view = renderAgentChat();

    await waitFor(() => {
      expect(view.getByText(/waiting for loop to become available/i)).toBeTruthy();
    });
  });
});

describe('AgentChat — deploying state', () => {
  it('shows a starting-up notice immediately when instanceStatus is not running', () => {
    const view = renderAgentChat({ instanceStatus: 'provisioning' });

    expect(view.getByText(/still starting up/i)).toBeTruthy();
    // Does not attempt launch when instance is not yet running
    expect(mockLaunchInstanceSession).not.toHaveBeenCalled();
  });

  it('shows deploying notice for stopped instances', () => {
    const view = renderAgentChat({ instanceStatus: 'stopped' });
    expect(view.getByText(/still starting up/i)).toBeTruthy();
  });
});

describe('AgentChat — missing configuration', () => {
  it('shows credential guidance when launch error indicates missing credential', async () => {
    mockLaunchInstanceSession.mockImplementation(() =>
      Promise.resolve({ launched: false, launchError: 'credential not found for agent ins_123' })
    );

    const view = renderAgentChat();

    await waitFor(() => {
      expect(view.getByText(/needs a credential/i)).toBeTruthy();
    });

    expect(view.queryByText(/credential not found/)).toBeNull();
    expect(mockCreateInstanceSession).not.toHaveBeenCalled();
  });

  it('renders a configure button when onConfigureAgent callback is provided', async () => {
    mockLaunchInstanceSession.mockImplementation(() =>
      Promise.resolve({ launched: false, launchError: 'credential not found' })
    );

    const onConfigureAgent = mock(() => undefined);
    const view = renderAgentChat({ onConfigureAgent });

    await waitFor(() => {
      expect(view.getByText(/configure the agent/i)).toBeTruthy();
    });
  });

  it('shows settings fallback when no onConfigureAgent callback is provided', async () => {
    mockLaunchInstanceSession.mockImplementation(() =>
      Promise.resolve({ launched: false, launchError: 'credential not found' })
    );

    const view = renderAgentChat();

    await waitFor(() => {
      expect(view.getByText(/Add a credential in Settings/i)).toBeTruthy();
    });
  });
});
