export function AdminPage(): React.ReactNode {
  return (
    <section className="shell admin-grid">
      <p className="kicker">Administración</p>
      <h1>Panel de la Cuencada</h1>
      <article className="card"><h2>Cuencadas</h2><p>Crear y editar años, fechas, ciudades, ubicaciones e itinerarios.</p></article>
      <article className="card"><h2>Invitaciones</h2><p>Enviar links por correo, WhatsApp o generar enlaces compartidos con límite de usos.</p></article>
      <article className="card"><h2>Fotos y recuerdos</h2><p>Moderar galerías de Linode Object Storage y destacar memorias públicas.</p></article>
      <article className="card"><h2>Familia</h2><p>Gestionar perfiles, árbol familiar, RSVPs y asistentes de eventos pasados.</p></article>
    </section>
  );
}
