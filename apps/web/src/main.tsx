// The mount, and nothing else. This module declares no component on
// purpose: a module that declares one becomes a React Refresh boundary,
// and a hot update then re-executes it in place — calling `createRoot` on
// `#root` a second time and leaving two reconcilers committing into one
// container. The root itself is kept on the HMR data slot so even a
// re-execution reuses the single root it already created.

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
