# Toast spy: delegate, never replace

`apps/web/src/react-ui-toast-mock.ts` spies on `@corbits/react-ui`'s `toast`
by delegating to the real implementation, not stubbing it out.

`mock.module` rewrites bun's module registry for the whole test process, not
just the calling file, and bun offers no way to undo it. A stub installed by
one test file stays installed for every later file bun loads — and
`toast-single-system.test.tsx` renders the real toaster and asserts on the
DOM, so a plain stub would make it fail for reasons unrelated to toasts.

By delegating, callers still get a call record to assert on, while any file
that renders a real `<Toaster />` keeps seeing real toasts regardless of
suite load order.
