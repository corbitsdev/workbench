# @corbits/walter-agent

Walter: a writer and editor agent, ported from the OG gtm-workbench's
`packages/agents/src/walter`. A default workbench teammate — no tool
connections to set up, no credentials beyond the inference the whole
workbench already runs on.

Drafts essays, memos, narratives, letters, speeches, and correspondence
from rough notes, transcripts, or ideas, always replying with the
finished piece directly rather than a description of one.

## What was left behind

The original declared one conditional tool, `artifact_link_file`, for
surfacing a file another tool had already placed in the workspace.
Workbench has no chat-agent-facing equivalent for that today, so it was
dropped rather than invented — Walter's prompt says plainly that he has
no tool to write or persist files, instead of instructing a tool call
that would never resolve.
