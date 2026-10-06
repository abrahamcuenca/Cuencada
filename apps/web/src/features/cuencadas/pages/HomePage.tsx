import { Link } from "react-router-dom";
// TODO(T2): replace the hardcoded 2026 data with `GET /api/cuencadas/home` and delete src/data/cuencada2026.ts.
import { cuencada2026 } from "../../../data/cuencada2026";

export function HomePage(): React.ReactNode {
  return (
    <>
      <section className="hero original-hero">
        <div className="hero-inner">
          <p className="kicker">MÉRIDA · YUCATÁN · 13-18 SEPTIEMBRE 2026</p>
          <h1>CUENCADA</h1>
          <h2>Una familia. Una historia. Una celebración.</h2>
          <p className="hero-copy">Bienvenidos al portal oficial de nuestra reunión familiar. Aquí encontrarás el programa, actividades, ubicaciones, álbumes, árbol familiar y recuerdos de cada Cuencada.</p>
          <div className="actions">
            <Link className="btn primary" to="/cuencada/2026">📅 Ver programa</Link>
            <Link className="btn light" to="/galeria">📸 Subir fotos</Link>
            <Link className="btn ghost" to="/entrar">👨‍👩‍👧‍👦 Entrar al portal</Link>
            <a className="btn whatsapp" href="https://chat.whatsapp.com/IvI6oayIIoEJ8Wn7EWQxO0?s=cl&p=i&mlu=0" rel="noreferrer" target="_blank">💬 Grupo WhatsApp</a>
          </div>
          <div className="countdown" aria-label="Cuenta regresiva">
            <div><b>342</b><span>días</span></div>
            <div><b>08</b><span>horas</span></div>
            <div><b>25</b><span>minutos</span></div>
            <div><b>10</b><span>segundos</span></div>
          </div>
        </div>
      </section>

      <section className="shell intro-section">
        <h2 className="section-title">Todo en un solo lugar</h2>
        <p className="intro">La página conserva el estilo práctico de la Cuencada 2026, pero ahora crecerá como portal familiar para consultar eventos pasados, organizar futuras reuniones y proteger fotos, RSVPs y datos familiares detrás de una cuenta.</p>
        <div className="grid cards-grid">
          <Link className="card" to="/cuencada/2026"><div className="icon">📅</div><h3>Programa</h3><p>Consulta cada día, horarios y actividades de la próxima Cuencada.</p></Link>
          <Link className="card" to="/galeria"><div className="icon">📸</div><h3>Álbum vivo</h3><p>Fotos y videos por año, privados para la familia.</p></Link>
          <Link className="card" to="/directorio"><div className="icon">🧭</div><h3>Directorio</h3><p>Perfiles familiares con privacidad para correo y teléfono.</p></Link>
          <Link className="card" to="/arbol"><div className="icon">🌳</div><h3>Árbol familiar</h3><p>Generaciones, parentescos e historia de la Familia Cuenca.</p></Link>
          <Link className="card" to="/cuencada/2026"><div className="icon">✅</div><h3>RSVP</h3><p>Confirma asistencia y mira quién va a cada reunión.</p></Link>
          <Link className="card" to="/admin"><div className="icon">⭐</div><h3>Admin</h3><p>Crear Cuencadas, editar itinerarios e invitar familiares.</p></Link>
        </div>
      </section>

      <section className="shell upload-panel">
        <div>
          <p className="kicker">PRÓXIMA CUENCADA</p>
          <h2>{cuencada2026.title}</h2>
          <p>{cuencada2026.city}, {cuencada2026.state} · 13 al 18 de septiembre de 2026</p>
          <div className="actions"><Link className="btn primary" to="/cuencada/2026">Abrir detalles</Link></div>
        </div>
        <div className="mini-card"><strong>Solo miembros</strong><p>Fotos, RSVP, chat, directorio y árbol familiar requieren iniciar sesión.</p></div>
      </section>

      <section className="shell">
        <h2 className="section-title">Últimos momentos</h2>
        <p className="intro">Una pequeña muestra de las fotografías de la Cuencada.</p>
        <div className="photo-mosaic">
          {["foto01", "foto02", "foto03", "foto04"].map((photo) => <img key={photo} src={`/images/fotos/${photo}.jpg`} alt="Cuencada 2026" />)}
        </div>
      </section>
    </>
  );
}
