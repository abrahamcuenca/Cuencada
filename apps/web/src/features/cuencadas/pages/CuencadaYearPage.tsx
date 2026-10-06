import { Link, useParams } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
// TODO(T2): replace the hardcoded 2026 data with `GET /api/cuencadas/:year` and delete src/data/cuencada2026.ts.
import { cuencada2026 } from "../../../data/cuencada2026";
import { selectCurrentUser } from "../../auth/authSlice";

export function CuencadaYearPage(): React.ReactNode {
  const { year } = useParams();
  const user = useAppSelector(selectCurrentUser);

  if (year !== "2026") {
    return <section className="shell"><h1>No encontramos esa Cuencada</h1><p>Por ahora los eventos anteriores se capturarán manualmente desde administración.</p></section>;
  }

  return (
    <>
      <section className="hero event-hero">
        <div className="hero-inner compact">
          <p className="kicker">Mérida · Yucatán · 13-18 septiembre 2026</p>
          <h1>{cuencada2026.title}</h1>
          <p className="hero-copy">{cuencada2026.description}</p>
          <div className="actions">
            <a className="btn primary" href="#programa">📅 Ver programa</a>
            {user ? <Link className="btn light" to="/galeria">📸 Subir fotos</Link> : <Link className="btn light" to="/entrar">✅ Iniciar sesión para RSVP</Link>}
            <a className="btn ghost" href="#mapa">🗺️ Ver lugares</a>
          </div>
        </div>
      </section>

      <section className="shell locked-grid">
        <article className="card"><div className="icon">🌤️</div><h3>Información pública</h3><p>Fechas, ciudad, hoteles base, mapas y programa general están disponibles para todos.</p></article>
        <article className="card"><div className="icon">🔒</div><h3>Solo miembros</h3><p>Fotos, asistentes, RSVP, chat, árbol familiar y directorio requieren cuenta familiar.</p></article>
        <article className="card"><div className="icon">🎵</div><h3>Nuestra canción</h3><p>La canción oficial se conservará dentro del portal.</p><audio controls src="/canciones/Cancion_Oficial.mp3"><track kind="captions" src="/canciones/Cancion_Oficial.vtt" srcLang="es" label="Español" /></audio></article>
      </section>

      <section id="programa" className="shell">
        <h2 className="section-title">📅 Programa Cuencada 2026</h2>
        <p className="intro">Del domingo 13 al viernes 18 de septiembre.</p>
        <div className="timeline">
          {cuencada2026.publicItinerary.map((item) => (
            <article className="day" key={item.id}>
              <div className="date">{new Date(`${item.date}T12:00:00`).toLocaleDateString("es-MX", { day: "numeric" })}<span>{new Date(`${item.date}T12:00:00`).toLocaleDateString("es-MX", { weekday: "long" })}</span></div>
              <div><h3>{item.title}</h3><p>{item.description}</p><div className="tags"><span className="tag">{item.startTime ?? "Horario por confirmar"}</span>{item.locationName ? <span className="tag">📍 {item.locationName}</span> : null}</div></div>
            </article>
          ))}
        </div>
      </section>

      <section className="shell attendee-strip">
        <p className="kicker">Familia que asistirá</p>
        {user ? <div className="avatar-row"><span>AC</span><span>JC</span><span>MC</span><span>LC</span><span>FC</span></div> : <p>Inicia sesión para ver RSVPs y fotos circulares de quienes asistirán.</p>}
      </section>

      <section id="mapa" className="shell">
        <h2 className="section-title">🗺️ Lugares principales</h2>
        <div className="mapgrid">
          {cuencada2026.publicLocations.map((location) => <article className="mapcard" key={location.id}><h3>{location.name}</h3><p>{location.kind === "hotel" ? "Hotel base de la Cuencada." : "Lugar importante del recorrido."}</p>{location.url ? <a href={location.url} target="_blank" rel="noreferrer">Abrir enlace →</a> : null}</article>)}
        </div>
      </section>
    </>
  );
}
