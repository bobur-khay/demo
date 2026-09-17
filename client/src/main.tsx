import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { defineCustomElement as defineUiEvent } from "@thingweb/ui-wot-components/components/ui-event";
import "./index.css";
import App from "./App.tsx";

defineUiEvent();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
