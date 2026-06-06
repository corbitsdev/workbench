/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockLaunchInstanceSession = mock(() =>
  Promise.resolve({ launched: false, launchError: 'sidecar not connected' })
);
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
  createBrowserTransport: () => ({}),
  createInstanceSession: mockCreateInstanceSession,
}));

import { AgentChat } from './AgentChat';

function renderAgentChat() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentChat instanceId="ins_123" tenantId="tnt_123" agentName="Loop" />
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  mockLaunchInstanceSession.mockClear();
  mockCreateInstanceSession.mockClear();
  mockStart.mockClear();
});

describe('AgentChat', () => {
  it('surfaces launch failures instead of hydrating a dead session', async () => {
    const view = renderAgentChat();

    await waitFor(() => {
      expect(view.getByText(/Could not connect to Loop/)).toBeTruthy();
    });

    expect(view.getByText(/sidecar not connected/)).toBeTruthy();
    expect(mockCreateInstanceSession).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });
});
