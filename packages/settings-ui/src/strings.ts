// Every user-facing word the settings surface prints, in one place. Nothing
// in the settings-ui/* components inlines its own copy; it imports from here.

export const SETTINGS_STRINGS = {
  pageTitle: "Settings",
  pageSubtitle: "Your bench, its chats and channels, and your account",
  sectionsNavLabel: "Settings sections",
  emptySectionsTitle: "Nothing to show",
  emptySectionsDescription: "No settings sections are available right now.",

  benchSectionTitle: "Bench",
  benchSectionDescription: "The bench you're currently working in.",
  benchNameLabel: "Name",
  benchAddressLabel: "Address",
  benchLoadError: "this bench",
  benchNoneSelectedTitle: "No bench selected",
  benchNoneSelectedDescription: "Choose a bench from the switcher first.",
  benchSaveError: "Couldn't rename this bench — try again.",
  benchMembersLink: "See all members on the Benches page",

  chatSectionTitle: "Chats & channels",
  chatSectionDescription: "Pick a chat or channel to edit its settings.",
  chatPickerLabel: "Channel",
  chatPickerEmptyTitle: "No chats or channels yet",
  chatPickerEmptyDescription: "Create one from the Chat page first.",
  chatLoadError: "channels",
  chatSettingsLoadError: "this channel's settings",
  chatNameLabel: "Name",
  chatPinnedLabel: "Pinned",
  chatPinnedDescription: "Pinned channels stay at the top for the whole bench.",
  chatContextWindowLabel: "Conversation memory",
  chatContextWindowDescription:
    "How much recent conversation a mentioned agent sees.",
  chatContextWindowDisabled: "Disabled — mentioned agents see no history",
  chatContextWindowDefault: "Default (last 20 messages)",
  chatContextWindowCustom: (count: number) => `Last ${count} messages`,
  chatContextWindowPlaceholder: "Default (20)",
  chatSaveError: "Couldn't save this channel's settings — try again.",

  accountSectionTitle: "Account",
  accountSectionDescription: "How the hub identifies you.",
  accountNameLabel: "Name",
  accountEmailLabel: "Email",
  accountLoadError: "your account",
  accountReadOnlyNote:
    "Managed through the authentication API; editing from this screen has not been built yet.",
} as const;
