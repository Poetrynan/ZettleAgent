import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initTheme } from "./lib/theme";
import { initDisableNativeContextMenu } from "./lib/disableNativeContextMenu";

initTheme();
initDisableNativeContextMenu();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
