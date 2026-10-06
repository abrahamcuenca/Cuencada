import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./shared/styles/tokens.css";
import "./shared/styles/base.css";
// Legacy page styles; removed as Phase-1 tracks port pages to shared/ui.
import "./styles.css";
import { App } from "./app/App";
import { bootstrapApp } from "./app/bootstrap";
import { store } from "./app/store";

const root = document.getElementById("root");

if (!root) throw new Error("No se encontró el contenedor principal.");

bootstrapApp(store);

createRoot(root).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>
);
