import { type } from "arktype";

export const IssueIdArgsSchema = type({
  id: "string > 0",
});

export const ListPaginationArgsSchema = type({
  "limit?": "number",
  "first?": "number",
  "cursor?": "string",
  "after?": "string",
});

export const OptionalTeamIdArgsSchema = type({
  "teamId?": "string",
  "team?": "string",
});