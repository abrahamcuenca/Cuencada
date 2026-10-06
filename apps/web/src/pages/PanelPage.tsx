import { Link } from "react-router-dom";
import { useAuth } from "../app/auth";

export function PanelPage(): React.ReactNode {
  const { user } = useAuth();
  return (
    <section className="shell">
      <p className="kicker">Panel familiar</p>
      <h1>Bienvenido, {user?.displayName}</h1>
      {user?.mustChangePassword ? <p className="notice">Tu cuenta admin usa una contraseña temporal. Cambia la contraseña antes de operar en producción.</p> : null}
      <div className="feature-grid">
        <Link className="card" to="/cuencada/2026"><h2>Confirmar asistencia</h2><p>RSVP para la próxima Cuencada.</p></Link>
        <Link className="card" to="/perfil"><h2>Mi perfil</h2><p>Foto, ciudad, rama familiar y privacidad.</p></Link>
        <Link className="card" to="/galeria"><h2>Mis fotos</h2><p>Sube y consulta recuerdos por año.</p></Link>
      </div>
    </section>
  );
}
