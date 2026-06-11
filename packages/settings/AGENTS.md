# @workbench/settings

Settings UI components: settings page layout, sections, and primitives. No data-fetching — receives current settings as props, emits change callbacks.

- Follows the same no-fetch rule as other UI packages; data loading lives in `apps/web`
- Uses `@workbench/ui` primitives for all interactive elements

## Testing

Follow the repository testing standards in the [root AGENTS.md](../../AGENTS.md#testing) — red/green (tests first), the 80% coverage floor (always aim higher), and the test-quality bar.
