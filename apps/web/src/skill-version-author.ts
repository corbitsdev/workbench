// Who saved a version of a skill, in words a person can read.
//
// A skill's version history IS its git history, so "who" arrives as a raw
// commit author name. Every save made through the product commits under the
// hub's own git identity (`interchange-hub`, fixed in
// `vendor/intx/hub-sessions/src/repo-store/store.ts`) — a machine account,
// not a teammate, and showing it verbatim invites a reader to mistake an
// internal name for a person. Per-principal attribution is not plumbed
// through the commit yet; until it is, the honest answer is the product's
// own name, never the internal one.
//
// A commit written by a real person — an imported skill, a repo edited
// outside the product — keeps their name exactly as git recorded it.

const HUB_GIT_AUTHOR = "interchange-hub";

export function skillVersionSavedBy(author: string): string {
  return author.trim() === HUB_GIT_AUTHOR ? "Workbench" : author;
}
