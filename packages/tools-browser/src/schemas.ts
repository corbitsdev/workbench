// Boundary schemas for the Browserbase REST responses. `'+': 'delete'` strips
// undeclared keys so a parsed value carries only the fields we depend on.
import { type } from 'arktype';

export const CreateSessionResponse = type({
  id: 'string > 0',
  connectUrl: 'string > 0',
  '+': 'delete',
});

export const SessionStatusResponse = type({
  status: 'string',
  '+': 'delete',
});

export const SessionSummary = type({
  id: 'string',
  status: 'string',
  'startedAt?': 'string',
  'createdAt?': 'string',
  '+': 'delete',
});

export type SessionSummary = typeof SessionSummary.infer;
