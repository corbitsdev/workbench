/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { Approval } from '../lib/approvals-api';

// framer-motion stub (not used here, but kept consistent with sibling tests)
mock.module('framer-motion', () => ({
  motion: {
    div: ({ children, className }: { children: React.ReactNode; className?: string }) =>
      React.createElement('div', { className }, children),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

const mockListApprovals = mock<() => Promise<Approval[]>>();
const mockApproveRequest = mock<() => Promise<Approval>>();
const mockRejectRequest = mock<() => Promise<Approval>>();

mock.module('../lib/approvals-api', () => ({
  listApprovals: mockListApprovals,
  approveRequest: mockApproveRequest,
  rejectRequest: mockRejectRequest,
}));

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'appr-1',
    tenantId: 'tenant-1',
    principalId: 'principal-1',
    agentId: 'agent-1',
    sessionId: 'session-1',
    resource: 'email://send',
    action: 'Send an email to acme@example.com',
    context: null,
    status: 'pending',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    ...overrides,
  };
}

function renderGate(tenantId = 'tenant-1', sessionId?: string) {
  const { ReviewGate } = require('./ReviewGate') as typeof import('./ReviewGate');
  return render(React.createElement(ReviewGate, { tenantId, sessionId }));
}

afterEach(() => {
  cleanup();
  mockListApprovals.mockClear();
  mockApproveRequest.mockClear();
  mockRejectRequest.mockClear();
});

describe('ReviewGate — empty state', () => {
  beforeEach(() => {
    mockListApprovals.mockResolvedValue([]);
  });

  it('renders nothing when there are no pending approvals', async () => {
    renderGate();
    // Allow the first poll to settle.
    await waitFor(() => {
      expect(mockListApprovals).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('review-gate')).toBeNull();
  });
});

describe('ReviewGate — pending approvals', () => {
  const pending = makeApproval();

  beforeEach(() => {
    mockListApprovals.mockResolvedValue([pending]);
  });

  it('renders a pending approval with action description and resource', async () => {
    renderGate();
    await waitFor(() => {
      expect(screen.getByTestId('review-gate')).toBeDefined();
    });
    expect(screen.getByText(pending.action)).toBeDefined();
    expect(screen.getByText(pending.resource)).toBeDefined();
  });

  it('renders an Approve button and a Reject button', async () => {
    renderGate();
    await waitFor(() => {
      expect(screen.getByTestId(`approve-${pending.id}`)).toBeDefined();
    });
    expect(screen.getByTestId(`reject-${pending.id}`)).toBeDefined();
  });
});

describe('ReviewGate — approve action', () => {
  const pending = makeApproval();
  const approved = makeApproval({ status: 'approved', resolvedAt: new Date().toISOString() });

  beforeEach(() => {
    mockListApprovals.mockResolvedValue([pending]);
    mockApproveRequest.mockResolvedValue(approved);
  });

  it('calls approveRequest with correct tenantId, approvalId and scope once', async () => {
    renderGate('tenant-1');
    await waitFor(() => {
      expect(screen.getByTestId(`approve-${pending.id}`)).toBeDefined();
    });

    fireEvent.click(screen.getByTestId(`approve-${pending.id}`));

    await waitFor(() => {
      expect(mockApproveRequest).toHaveBeenCalledWith('tenant-1', pending.id, 'once');
    });
  });

  it('shows the approved status badge after a successful approval', async () => {
    renderGate();
    await waitFor(() => {
      expect(screen.getByTestId(`approve-${pending.id}`)).toBeDefined();
    });

    fireEvent.click(screen.getByTestId(`approve-${pending.id}`));

    await waitFor(() => {
      expect(screen.getByText('approved')).toBeDefined();
    });
  });
});

describe('ReviewGate — reject action', () => {
  const pending = makeApproval();
  const rejected = makeApproval({ status: 'rejected', resolvedAt: new Date().toISOString() });

  beforeEach(() => {
    mockListApprovals.mockResolvedValue([pending]);
    mockRejectRequest.mockResolvedValue(rejected);
  });

  it('calls rejectRequest with correct tenantId and approvalId', async () => {
    renderGate('tenant-1');
    await waitFor(() => {
      expect(screen.getByTestId(`reject-${pending.id}`)).toBeDefined();
    });

    fireEvent.click(screen.getByTestId(`reject-${pending.id}`));

    await waitFor(() => {
      expect(mockRejectRequest).toHaveBeenCalledWith('tenant-1', pending.id);
    });
  });

  it('shows the rejected status badge after a successful rejection', async () => {
    renderGate();
    await waitFor(() => {
      expect(screen.getByTestId(`reject-${pending.id}`)).toBeDefined();
    });

    fireEvent.click(screen.getByTestId(`reject-${pending.id}`));

    await waitFor(() => {
      expect(screen.getByText('rejected')).toBeDefined();
    });
  });
});

describe('ReviewGate — sessionId filter', () => {
  const matchingSession = makeApproval({ id: 'appr-match', sessionId: 'sess-target' });
  const otherSession = makeApproval({ id: 'appr-other', sessionId: 'sess-other' });

  beforeEach(() => {
    mockListApprovals.mockResolvedValue([matchingSession, otherSession]);
  });

  it('shows only approvals matching the given sessionId', async () => {
    renderGate('tenant-1', 'sess-target');
    await waitFor(() => {
      expect(screen.getByTestId(`approval-appr-match`)).toBeDefined();
    });
    expect(screen.queryByTestId('approval-appr-other')).toBeNull();
  });
});

describe('ReviewGate — resolved items reduced opacity', () => {
  const resolved = makeApproval({ status: 'approved', resolvedAt: new Date().toISOString() });

  beforeEach(() => {
    mockListApprovals.mockResolvedValue([resolved]);
  });

  it('renders resolved approvals with reduced opacity class', async () => {
    renderGate();
    await waitFor(() => {
      expect(screen.getByTestId(`approval-${resolved.id}`)).toBeDefined();
    });
    const el = screen.getByTestId(`approval-${resolved.id}`);
    expect(el.className).toContain('opacity-50');
  });
});
