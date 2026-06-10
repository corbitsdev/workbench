# @workbench/client

Framework-agnostic data-access layer for the hub API. Returns `@workbench/shared` domain types; contains no presentation logic.

- All functions accept `ClientOptions` (`baseUrl`, `fetch`, `init`) for portability across apps and tests
- No React imports — usable in Node, workers, or non-browser runtimes
- Add new endpoints here when the hub exposes them; keep one function per route

## Testing

Follow the repository testing standards in the [root AGENTS.md](../../AGENTS.md#testing) — red/green (tests first), the 80% coverage floor (always aim higher), and the test-quality bar.
