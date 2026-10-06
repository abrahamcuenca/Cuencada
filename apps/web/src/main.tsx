import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { AuthProvider } from "./app/auth";
import { router } from "./app/router";
import "./styles.css";

const root = document.getElementById("root");

if (!root) throw new Error("No se encontró el contenedor principal.");

createRoot(root).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>
);
