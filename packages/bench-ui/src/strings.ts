// Every user-facing word the bench surface prints, in one place. Nothing in
// the bench-ui/* components inlines its own copy; it imports from here.

export const BENCH_STRINGS = {
  switcherLabel: "Bench",
  switcherEmpty: "No benches",

  membersSectionTitle: "Members",
  membersSectionDescription: "Everyone on the current bench, and their roles.",
  membersEmptyTitle: "No members yet",
  membersEmptyDescription: "This bench has no members other than you.",
  membersLoadError: "this bench's members",
  memberUnnamed: "Unnamed member",
  memberRoleNone: "none",

  createBenchAction: "+ New workbench",
  createBenchDialogTitle: "New workbench",

  createBenchDialogDescription:
    "Give it a name. The bench's address is derived from the name.",
  createBenchNameLabel: "Name",
  createBenchNamePlaceholder: "e.g. Launch team",
  createBenchSlugPreviewLabel: "Address",
  createBenchSubmit: "Create",
  createBenchCancel: "Cancel",
  createBenchError: "Couldn't create that bench — try again.",
  createBenchConflictError:
    "That name is already taken by another bench — try a different name.",

  inviteMemberAction: "Invite member",
  inviteMemberDialogTitle: "Invite a member",
  inviteMemberDialogDescription:
    "Invite an existing account to this bench by email.",
  inviteMemberEmailLabel: "Email",
  inviteMemberEmailPlaceholder: "person@example.com",
  inviteMemberSubmit: "Invite",
  inviteMemberCancel: "Cancel",
  inviteMemberInviting: "Inviting…",
  inviteMemberNotFoundError: "No account exists with that email yet.",
  inviteMemberConflictError: "That person is already a member of this bench.",
  inviteMemberError: "Couldn't send that invite — try again.",

  statusActive: "active",
  statusInvited: "invited",
  statusSuspended: "suspended",
  statusDeactivated: "deactivated",
} as const;
