/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as hubClientActual from '@intx/hub-client';
import type { LaunchInstanceSessionResponse } from '../lib/hub-api';

// Launch responses are driven through the real launchInstanceSession by stubbing
// the fetch boundary, instead of module-mocking hub-api (which leaks across
// files under bun and replaced the real module in hub-api.test). createHubTransport
// runs for real against a no-op EventSource. @intx/hub-client is the Interchange
// boundary and may be mocked, but we spread the real exports so other files'
// imports (e.g. ApiError) keep working.
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

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

mock.module('@intx/hub-client', () => ({
  ...hubClientActual,
  createInstanceSession: mockCreateInstanceSession,
}));

class NoopEventSource {
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(): void {}
  close(): void {}
}

let launchQueue: LaunchInstanceSessionResponse[] = [];
let defaultLaunch: LaunchInstanceSessionResponse = {
  launched: false,
  launchError: 'sidecar not connected',
};
let launchUrls: string[] = [];

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  (
    globalThis as unknown as { window: { happyDOM: { setURL: (u: string) => void } } }
  ).window.happyDOM.setURL('http://localhost/');
  launchQueue = [];
  launchUrls = [];
  defaultLaunch = { launched: false, launchError: 'sidecar not connected' };
  globalThis.fetch = mock((url: string) => {
    if (String(url).includes('/sessions')) {
      launchUrls.push(String(url));
      return Promise.resolve(
        jsonResponse(launchQueue.length ? launchQueue.shift() : defaultLaunch)
      );
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
  globalThis.EventSource = NoopEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  mockCreateInstanceSession.mockClear();
  mockStart.mockClear();
});

function renderAgentChat(overrides?: {
  instanceStatus?: string;
  onConfigureAgent?: () => void;
  retryDelayMs?: number;
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentChat instanceId="ins_123" tenantId="tnt_123" agentName="Loop" {...overrides} />
    </QueryClientProvider>
  );
}

describe('AgentChat — fatal launch error', () => {
  it('does not hydrate a session and shows retry for an unrecognised error', async () => {
    defaultLaunch = { launched: false, launchError: 'internal server error' };

    const view = renderAgentChat();

    await waitFor(() => {
      expect(view.getByText(/could not be reached/i)).toBeTruthy();
    });

    expect(view.getByText(/try again/i)).toBeTruthy();
    expect(mockCreateInstanceSession).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('attempts to launch deployed agents instead of treating them as dead', async () => {
    launchQueue = [{ launched: true }];

    renderAgentChat({ instanceStatus: 'deployed' });

    await waitFor(() => {
      expect(launchUrls.some((u) => u.includes('/instances/ins_123/sessions'))).toBe(true);
    });

    await waitFor(() => {
      expect(mockCreateInstanceSession).toHaveBeenCalled();
    });
    expect(mockStart).toHaveBeenCalled();
  });

  it('does not leak raw error strings to the user', async () => {
    defaultLaunch = { launched: false, launchError: '502 Bad Gateway' };

    const view = renderAgentChat();

    await waitFor(() => {
      expect(view.getByText(/could not be reached/i)).toBeTruthy();
    });

    expect(view.queryByText(/502 Bad Gateway/)).toBeNull();
  });
});

describe('AgentChat — transient launch errors', () => {
  it('shows a waiting notice for sidecar-not-connected errors instead of an error', async () => {
    defaultLaunch = { launched: false, launchError: 'No sidecar connected for agent "ins_123"' };

    const view = renderAgentChat();

    await waitFor(() => {
      expect(view.getByText(/waiting for loop to become available/i)).toBeTruthy();
    });

    expect(view.queryByText(/No sidecar connected/)).toBeNull();
    expect(mockCreateInstanceSession).not.toHaveBeenCalled();
  });

  it('shows a waiting notice for sidecar-not-available errors', async () => {
    defaultLaunch = { launched: false, launchError: 'No sidecar available for agent "ins_123"' };

    const view = renderAgentChat();

    await waitFor(() => {
      expect(view.getByText(/waiting for loop to become available/i)).toBeTruthy();
    });

    expect(view.queryByText(/No sidecar available/)).toBeNull();
  });

  it('auto-retries the launch while the sidecar is unavailable, then connects once it returns', async () => {
    launchQueue = [
      { launched: false, launchError: 'No sidecar available for agent "ins_123"' },
      { launched: true },
    ];

    const view = renderAgentChat({ retryDelayMs: 10 });

    await waitFor(() => {
      expect(view.getByText(/waiting for loop to become available/i)).toBeTruthy();
    });

    // The scheduled retry fires and succeeds, so the session hydrates.
    await waitFor(() => {
      expect(launchUrls.length).toBe(2);
    });
    await waitFor(() => {
      expect(mockCreateInstanceSession).toHaveBeenCalled();
    });
  });

  it('shows a waiting notice for legacy sidecar-not-connected messages', async () => {
    // Default response returns { launchError: 'sidecar not connected' }
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
    expect(launchUrls).toHaveLength(0);
  });

  it('shows deploying notice for stopped instances', () => {
    const view = renderAgentChat({ instanceStatus: 'stopped' });
    expect(view.getByText(/still starting up/i)).toBeTruthy();
  });
});

describe('AgentChat — missing configuration', () => {
  it('shows credential guidance when launch error indicates missing credential', async () => {
    defaultLaunch = { launched: false, launchError: 'credential not found for agent ins_123' };

    const view = renderAgentChat();

    await waitFor(() => {
      expect(view.getByText(/needs a credential/i)).toBeTruthy();
    });

    expect(view.queryByText(/credential not found/)).toBeNull();
    expect(mockCreateInstanceSession).not.toHaveBeenCalled();
  });

  it('renders a configure button when onConfigureAgent callback is provided', async () => {
    defaultLaunch = { launched: false, launchError: 'credential not found' };

    const onConfigureAgent = mock(() => undefined);
    const view = renderAgentChat({ onConfigureAgent });

    await waitFor(() => {
      expect(view.getByText(/configure the agent/i)).toBeTruthy();
    });
  });

  it('shows settings fallback when no onConfigureAgent callback is provided', async () => {
    defaultLaunch = { launched: false, launchError: 'credential not found' };

    const view = renderAgentChat();

    await waitFor(() => {
      expect(view.getByText(/Add a credential in Settings/i)).toBeTruthy();
    });
  });
});

import { AgentChat } from './AgentChat';
