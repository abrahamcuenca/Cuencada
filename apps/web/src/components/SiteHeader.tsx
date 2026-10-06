import { Link, NavLink } from "react-router-dom";
import { useAuth } from "../app/auth";

export function SiteHeader(): React.ReactNode {
  const { user, loginAsDemoAdmin, logout } = useAuth();

  return (
    <header className="site-header">
      <Link className="brand" to="/">
        <img src="/images/Logo_Cuencada2026.jpg" alt="Logo Cuencada 2026" />
        <span>Cuencada</span>
      </Link>
      <nav aria-label="Navegación principal">
        <NavLink to="/cuencada/2026">Programa</NavLink>
        <NavLink to="/galeria">Galería</NavLink>
        <NavLink to="/directorio">Directorio</NavLink>
        <NavLink to="/arbol">Árbol</NavLink>
        <NavLink to="/panel">Panel</NavLink>
        {user?.role === "admin" ? <NavLink to="/admin">Admin</NavLink> : null}
      </nav>
      {user ? <button type="button" onClick={logout}>Salir</button> : <button type="button" onClick={loginAsDemoAdmin}>Demo admin</button>}
    </header>
  );
}
