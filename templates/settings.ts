// Re-exported from `@corbits/connections` — the `template/*` settings
// vocabulary is generic (an arktype schema plus a builder), not
// product-specific data, so it lives with the connections package that
// actually consumes it (`connect-github-routes.ts`'s repo-review
// settling). Kept here too so nothing that already imports
// `@workbench/templates/settings` has to change.
export {
  TemplateReposSettingsPatch,
  TemplateSettingsPatch,
  templateReposSettingsPatch,
  templateSettingsPatch,
} from "@corbits/connections/template-settings";
