import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { SiteHeader } from "../components/SiteHeader";
import { AdminPage } from "../pages/AdminPage";
import { ArbolPage } from "../pages/ArbolPage";
import { CuencadaYearPage } from "../pages/CuencadaYearPage";
import { DirectorioPage } from "../pages/DirectorioPage";
import { GaleriaPage } from "../pages/GaleriaPage";
import { HomePage } from "../pages/HomePage";
import { PanelPage } from "../pages/PanelPage";
import { PerfilPage } from "../pages/PerfilPage";
import { useAuth } from "./auth";

function Layout(): React.ReactNode {
  return (
    <>
      <SiteHeader />
      <main>
        <Outlet />
      </main>
    </>
  );
}

function RequireAuth(): React.ReactNode {
  const { status, user } = useAuth();
  if (status === "loading") return <div className="shell"><p>Cargando tu sesión...</p></div>;
  if (!user) return <Navigate to="/" replace />;
  return <Outlet />;
}

function RequireAdmin(): React.ReactNode {
  const { status, user } = useAuth();
  if (status === "loading") return <div className="shell"><p>Cargando tu sesión...</p></div>;
  if (!user) return <Navigate to="/" replace />;
  if (user.role !== "admin") return <Navigate to="/panel" replace />;
  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/cuencada/:year", element: <CuencadaYearPage /> },
      {
        element: <RequireAuth />,
        children: [
          { path: "/arbol", element: <ArbolPage /> },
          { path: "/directorio", element: <DirectorioPage /> },
          { path: "/galeria", element: <GaleriaPage /> },
          { path: "/panel", element: <PanelPage /> },
          { path: "/perfil", element: <PerfilPage /> }
        ]
      },
      {
        element: <RequireAdmin />,
        children: [{ path: "/admin", element: <AdminPage /> }]
      },
      { path: "*", element: <Navigate to="/" replace /> }
    ]
  }
]);
