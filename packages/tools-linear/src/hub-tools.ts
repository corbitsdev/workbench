import type { ToolDefinition } from "@intx/types/runtime";
import {
  createAttachmentFromUpload,
  getAttachment,
  LINEAR_CREATE_ATTACHMENT_FROM_UPLOAD_DEFINITION,
  LINEAR_GET_ATTACHMENT_DEFINITION,
  LINEAR_PREPARE_ATTACHMENT_UPLOAD_DEFINITION,
  prepareAttachmentUpload,
} from "./attachments";
import {
  listComments,
  LINEAR_LIST_COMMENTS_DEFINITION,
  LINEAR_SAVE_COMMENT_DEFINITION,
  saveComment,
} from "./comments";
import { listCycles, LINEAR_LIST_CYCLES_DEFINITION } from "./cycles";
import {
  listIntegrations,
  LINEAR_LIST_INTEGRATIONS_DEFINITION,
} from "./integrations";
import {
  getDocument,
  listDocuments,
  LINEAR_GET_DOCUMENT_DEFINITION,
  LINEAR_LIST_DOCUMENTS_DEFINITION,
  LINEAR_SAVE_DOCUMENT_DEFINITION,
  saveDocument,
} from "./documents";
import {
  listInitiatives,
  LINEAR_LIST_INITIATIVES_DEFINITION,
  LINEAR_SAVE_INITIATIVE_DEFINITION,
  saveInitiative,
} from "./initiatives";
import {
  archiveIssue,
  createIssue,
  deleteIssue,
  getIssue,
  linkIssues,
  listIssues,
  LINEAR_ARCHIVE_ISSUE_DEFINITION,
  LINEAR_CREATE_ISSUE_DEFINITION,
  LINEAR_DELETE_ISSUE_DEFINITION,
  LINEAR_GET_ISSUE_DEFINITION,
  LINEAR_LINK_ISSUES_DEFINITION,
  LINEAR_LIST_ISSUES_DEFINITION,
  LINEAR_UPDATE_ISSUE_DEFINITION,
  updateIssue,
} from "./issues";
import {
  createIssueLabel,
  LINEAR_CREATE_ISSUE_LABEL_DEFINITION,
  LINEAR_LIST_INITIATIVE_LABELS_DEFINITION,
  LINEAR_LIST_ISSUE_LABELS_DEFINITION,
  LINEAR_LIST_PROJECT_LABELS_DEFINITION,
  listInitiativeLabels,
  listIssueLabels,
  listProjectLabels,
} from "./labels";
import {
  listMilestones,
  LINEAR_LIST_MILESTONES_DEFINITION,
  LINEAR_SAVE_MILESTONE_DEFINITION,
  saveMilestone,
} from "./milestones";
import {
  getProject,
  listProjects,
  LINEAR_GET_PROJECT_DEFINITION,
  LINEAR_LIST_PROJECTS_DEFINITION,
  LINEAR_SAVE_PROJECT_DEFINITION,
  saveProject,
} from "./projects";
import {
  listReleases,
  LINEAR_LIST_RELEASES_DEFINITION,
  LINEAR_SAVE_RELEASE_DEFINITION,
  saveRelease,
} from "./releases";
import { listDashboards, LINEAR_LIST_DASHBOARDS_DEFINITION } from "./analytics";
import { searchLinear, LINEAR_SEARCH_DEFINITION } from "./search";
import {
  getIssueStatus,
  LINEAR_GET_ISSUE_STATUS_DEFINITION,
  LINEAR_LIST_ISSUE_STATUSES_DEFINITION,
  listIssueStatuses,
} from "./statuses";
import {
  getTeam,
  listTeams,
  LINEAR_GET_TEAM_DEFINITION,
  LINEAR_LIST_TEAMS_DEFINITION,
} from "./teams";
import { getUser, listUsers, LINEAR_GET_USER_DEFINITION, LINEAR_LIST_USERS_DEFINITION } from "./users";
import { listViews, LINEAR_LIST_VIEWS_DEFINITION } from "./views";
import {
  deleteWebhook,
  LINEAR_DELETE_WEBHOOK_DEFINITION,
  LINEAR_LIST_WEBHOOKS_DEFINITION,
  LINEAR_SAVE_WEBHOOK_DEFINITION,
  listWebhooks,
  saveWebhook,
} from "./webhooks";
import { linearHubEntry, type LinearHubToolEntry } from "./tool-runtime";

export const LINEAR_HUB_TOOLS: Record<string, LinearHubToolEntry> = {
  linear_list_issues: linearHubEntry(
    LINEAR_LIST_ISSUES_DEFINITION,
    listIssues,
    "read",
  ),
  linear_get_issue: linearHubEntry(LINEAR_GET_ISSUE_DEFINITION, getIssue, "read"),
  linear_create_issue: linearHubEntry(
    LINEAR_CREATE_ISSUE_DEFINITION,
    createIssue,
    "write",
  ),
  linear_update_issue: linearHubEntry(
    LINEAR_UPDATE_ISSUE_DEFINITION,
    updateIssue,
    "write",
  ),
  linear_archive_issue: linearHubEntry(
    LINEAR_ARCHIVE_ISSUE_DEFINITION,
    archiveIssue,
    "write",
  ),
  linear_delete_issue: linearHubEntry(
    LINEAR_DELETE_ISSUE_DEFINITION,
    deleteIssue,
    "write",
  ),
  linear_link_issues: linearHubEntry(
    LINEAR_LINK_ISSUES_DEFINITION,
    linkIssues,
    "write",
  ),
  linear_list_comments: linearHubEntry(
    LINEAR_LIST_COMMENTS_DEFINITION,
    listComments,
    "read",
  ),
  linear_save_comment: linearHubEntry(
    LINEAR_SAVE_COMMENT_DEFINITION,
    saveComment,
    "write",
  ),
  linear_get_attachment: linearHubEntry(
    LINEAR_GET_ATTACHMENT_DEFINITION,
    getAttachment,
    "read",
  ),
  linear_prepare_attachment_upload: linearHubEntry(
    LINEAR_PREPARE_ATTACHMENT_UPLOAD_DEFINITION,
    prepareAttachmentUpload,
    "write",
  ),
  linear_create_attachment_from_upload: linearHubEntry(
    LINEAR_CREATE_ATTACHMENT_FROM_UPLOAD_DEFINITION,
    createAttachmentFromUpload,
    "write",
  ),
  linear_list_documents: linearHubEntry(
    LINEAR_LIST_DOCUMENTS_DEFINITION,
    listDocuments,
    "read",
  ),
  linear_get_document: linearHubEntry(
    LINEAR_GET_DOCUMENT_DEFINITION,
    getDocument,
    "read",
  ),
  linear_save_document: linearHubEntry(
    LINEAR_SAVE_DOCUMENT_DEFINITION,
    saveDocument,
    "write",
  ),
  linear_list_projects: linearHubEntry(
    LINEAR_LIST_PROJECTS_DEFINITION,
    listProjects,
    "read",
  ),
  linear_get_project: linearHubEntry(
    LINEAR_GET_PROJECT_DEFINITION,
    getProject,
    "read",
  ),
  linear_save_project: linearHubEntry(
    LINEAR_SAVE_PROJECT_DEFINITION,
    saveProject,
    "write",
  ),
  linear_list_milestones: linearHubEntry(
    LINEAR_LIST_MILESTONES_DEFINITION,
    listMilestones,
    "read",
  ),
  linear_save_milestone: linearHubEntry(
    LINEAR_SAVE_MILESTONE_DEFINITION,
    saveMilestone,
    "write",
  ),
  linear_list_initiatives: linearHubEntry(
    LINEAR_LIST_INITIATIVES_DEFINITION,
    listInitiatives,
    "read",
  ),
  linear_save_initiative: linearHubEntry(
    LINEAR_SAVE_INITIATIVE_DEFINITION,
    saveInitiative,
    "write",
  ),
  linear_list_cycles: linearHubEntry(
    LINEAR_LIST_CYCLES_DEFINITION,
    listCycles,
    "read",
  ),
  linear_list_releases: linearHubEntry(
    LINEAR_LIST_RELEASES_DEFINITION,
    listReleases,
    "read",
  ),
  linear_save_release: linearHubEntry(
    LINEAR_SAVE_RELEASE_DEFINITION,
    saveRelease,
    "write",
  ),
  linear_list_teams: linearHubEntry(
    LINEAR_LIST_TEAMS_DEFINITION,
    listTeams,
    "read",
  ),
  linear_get_team: linearHubEntry(LINEAR_GET_TEAM_DEFINITION, getTeam, "read"),
  linear_list_users: linearHubEntry(
    LINEAR_LIST_USERS_DEFINITION,
    listUsers,
    "read",
  ),
  linear_get_user: linearHubEntry(LINEAR_GET_USER_DEFINITION, getUser, "read"),
  linear_list_issue_labels: linearHubEntry(
    LINEAR_LIST_ISSUE_LABELS_DEFINITION,
    listIssueLabels,
    "read",
  ),
  linear_create_issue_label: linearHubEntry(
    LINEAR_CREATE_ISSUE_LABEL_DEFINITION,
    createIssueLabel,
    "write",
  ),
  linear_list_project_labels: linearHubEntry(
    LINEAR_LIST_PROJECT_LABELS_DEFINITION,
    listProjectLabels,
    "read",
  ),
  linear_list_initiative_labels: linearHubEntry(
    LINEAR_LIST_INITIATIVE_LABELS_DEFINITION,
    listInitiativeLabels,
    "read",
  ),
  linear_list_issue_statuses: linearHubEntry(
    LINEAR_LIST_ISSUE_STATUSES_DEFINITION,
    listIssueStatuses,
    "read",
  ),
  linear_get_issue_status: linearHubEntry(
    LINEAR_GET_ISSUE_STATUS_DEFINITION,
    getIssueStatus,
    "read",
  ),
  linear_search: linearHubEntry(LINEAR_SEARCH_DEFINITION, searchLinear, "read"),
  linear_list_views: linearHubEntry(
    LINEAR_LIST_VIEWS_DEFINITION,
    listViews,
    "read",
  ),
  linear_list_dashboards: linearHubEntry(
    LINEAR_LIST_DASHBOARDS_DEFINITION,
    listDashboards,
    "read",
  ),
  linear_list_webhooks: linearHubEntry(
    LINEAR_LIST_WEBHOOKS_DEFINITION,
    listWebhooks,
    "read",
  ),
  linear_save_webhook: linearHubEntry(
    LINEAR_SAVE_WEBHOOK_DEFINITION,
    saveWebhook,
    "write",
  ),
  linear_delete_webhook: linearHubEntry(
    LINEAR_DELETE_WEBHOOK_DEFINITION,
    deleteWebhook,
    "write",
  ),
  linear_list_integrations: linearHubEntry(
    LINEAR_LIST_INTEGRATIONS_DEFINITION,
    listIntegrations,
    "read",
  ),
};

export const LINEAR_DEFINITIONS: ToolDefinition[] = Object.values(
  LINEAR_HUB_TOOLS,
).map((entry) => entry.definition);