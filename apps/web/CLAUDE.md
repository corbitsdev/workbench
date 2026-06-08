See [AGENTS.md](./AGENTS.md).

# Web App Guidelines

## React Patterns

- **Avoid unnecessary useEffect**: Read [alejandrobailo/no-use-effect](https://github.com/alejandrobailo/no-use-effect) for patterns and anti-patterns. Many `useEffect` calls can be replaced with proper state management or moved to event handlers.

## Data Handling

- **No fallbacks for uncertain data**: Do proper type checks and validation for EVERYTHING. Only use fallback values where it is absolutely necessary (e.g., defaults from API contracts that are guaranteed).
- Prefer explicit error handling and null checks over silent fallbacks.
- If a value might be undefined, handle it explicitly rather than assuming it has a safe default.

## Component Architecture

- Keep components focused on presentation
- Handle API calls and state at the page level or in custom hooks
- Use TypeScript strict mode; trust the type system
