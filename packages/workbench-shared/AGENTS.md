# @workbench/shared

Shared domain types used by both hub and web. No runtime logic — types only.

- Add a type here when it is needed by both frontend and backend
- No imports from app packages (`apps/hub`, `apps/web`) or Interchange internals
- Keep types minimal; rich behavior belongs in the consuming package

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
