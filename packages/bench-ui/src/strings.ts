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
    "Name the workbench and choose how it relates to others.",
  createBenchNameLabel: "Name",
  createBenchNamePlaceholder: "e.g. Launch team",
  createBenchPurposeLabel: "Purpose (optional)",
  createBenchPurposePlaceholder: "What will this workbench be used for?",
  createBenchTypeLabel: "Type",
  createBenchTypeGlobal: "Global",
  createBenchTypeGlobalDesc: "A top-level workbench with its own membership.",
  createBenchTypeSub: "Sub-workbench",
  createBenchTypeSubDesc:
    "Inherits people and policy from a parent (inheritance wiring lands later).",
  createBenchJoinPolicyLabel: "Join policy",
  createBenchJoinPolicyClosed:
    "Closed — invites only (matches operator signup defaults).",
  createBenchJoinPolicyOpen: "Open to allowed domains when signup is open.",
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
