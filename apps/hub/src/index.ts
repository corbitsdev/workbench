import { createHubServer } from "./server";
import { populateDbEnvFromDatabaseUrl, withStaticWeb } from "./static-web";

populateDbEnvFromDatabaseUrl();

const server = await createHubServer();
const webDistDir = process.env["WEB_DIST_DIR"] ?? process.env["PORTAL_DIR"];

export default {
  ...server,
  fetch: withStaticWeb(webDistDir, server.fetch),
};
