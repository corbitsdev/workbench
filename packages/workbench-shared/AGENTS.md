# @workbench/shared

Shared domain types and pure, framework-agnostic domain logic used by both hub
and web — exported arktype schemas plus the small pure functions that operate on
them (e.g. the active-context projector). No React, no I/O, no app or Interchange
internals.

- Add a type here when it is needed by both frontend and backend
- Pure, dependency-free domain logic that both apps need (a projector, a
  formatter) belongs here so the apps stay thin; anything stateful, async, or
  framework-bound does not
- No imports from app packages (`apps/hub`, `apps/web`) or Interchange internals
- Keep the surface minimal; rich, stateful behavior belongs in the consuming package

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
