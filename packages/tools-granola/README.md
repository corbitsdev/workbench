# @corbits/tools-granola

Fetches a Granola call note, with its diarized transcript, by note id —
the one Granola capability `@corbits/pain-point-collateral-workflow`'s
intake step needs. Ported from `gtm-workbench`'s
`packages/tools-granola`, trimmed to the single tool this repo currently
has a caller for.

```ts
import { createGranolaTools } from "@corbits/tools-granola";

const tools = createGranolaTools({ apiKey });
// tools[0] is granola_get_note: { noteId } -> { id, title, participants, summary, transcript }
```

Add more of Granola's API (listing notes, folders, briefs) here when a
workflow actually needs it — this package stays a thin, dependency-free
wrapper (arktype + `fetch`) rather than a speculative full client.
