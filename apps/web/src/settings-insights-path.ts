// The path the Settings dialog hands its embedded Insights route. The route
// falls back to the browser URL when it gets no path, and the dialog's own
// `/settings/insights` parses as an Insights landing page — landing renders a
// redirect to a top-level route, which unmounts the dialog. Hand it the runs
// history instead: that mode renders inline and never navigates away.

import { INSIGHTS_RUNS_PATH } from "./path-ids";

export const SETTINGS_INSIGHTS_PATH = INSIGHTS_RUNS_PATH;
