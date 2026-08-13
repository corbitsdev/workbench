# Toast confirmations

Every successful mutation confirms itself with the shared toast from
`@corbits/react-ui`: a single plain-text line that fades in over the bottom
center, holds briefly, and fades out. A new confirmation replaces the one on
screen rather than stacking, so rapid mutations read as one status line.

## How to adopt it

- The `<Toaster />` mounts once, in `apps/web/src/main.tsx` inside the
  `ThemeProvider`. Never mount a second one.
- Fire `toast(message)` from the mutation's success path — after the awaited
  call resolves, alongside the reload/invalidate. Failures keep their
  existing inline error states; the toast is for success only.
- Copy lives with the surface's other copy: `CHAT_STRINGS` for chat,
  `SETTINGS_STRINGS` for settings, and pure helpers (`artifactUploadToast`,
  `routineCreatedToast`, `routineRunStartedToast`) next to the API module
  they describe. No component inlines bespoke toast copy.
- Copy is a plain confirmation. Where it names a subject, `·` separates the
  action from it: `Channel created · Launch planning`, `Uploaded ·
q3-report.pdf`, `Credential saved · value hidden`. A multi-file upload is
  the one count form: `Uploaded 4 files`. State toggles read as the state
  just entered (`Pinned Deploy notes`), and bare confirmations stay bare
  (`Grant created`, `Settings saved`).

## Where it fires today

Channel create, rename, pin/unpin, and channel settings save; routine create
and run-now; grant create and revoke; credential save and revoke; artifact
upload; bench name and conversation-default saves.
