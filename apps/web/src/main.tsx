// No component declared here on purpose: that would make this module a
// React Refresh boundary, whose hot re-execution would call `createRoot`
// twice. The root is kept on the HMR data slot to survive re-execution.

import "@corbits/react-ui/styles.css";
import "./app.css";
import "./tailwind.css";

import { StrictMode } from "react";
import { createRoot, type Root as ReactRoot } from "react-dom/client";

import { AppErrorBoundary } from "./app-error-boundary";
import { Root } from "./root";

const container = document.getElementById("root");
if (container === null) throw new Error("index.html is missing #root");

const hotData = import.meta.hot?.data as { root?: ReactRoot } | undefined;
const root = hotData?.root ?? createRoot(container);
if (hotData !== undefined) hotData.root = root;

root.render(
  <StrictMode>
    <AppErrorBoundary>
      <Root />
    </AppErrorBoundary>
  </StrictMode>,
);
