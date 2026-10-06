import { type ReactNode, useEffect, useState } from "react";
import "../styles/tokens.css";
import "../styles/base.css";
import { AvatarCircle } from "./AvatarCircle";
import { AvatarStack } from "./AvatarStack";
import { Badge } from "./Badge";
import { BottomNav } from "./BottomNav";
import { Button } from "./Button";
import { Card } from "./Card";
import { Checkbox, Switch } from "./Checkbox";
import { Countdown } from "./Countdown";
import { Dialog } from "./Dialog";
import { EmptyState } from "./EmptyState";
import { Field } from "./Field";
import { IconButton } from "./IconButton";
import { Lightbox, type LightboxItem } from "./Lightbox";
import { PageShell } from "./PageShell";
import { Select } from "./Select";
import { Skeleton } from "./Skeleton";
import { Spinner } from "./Spinner";
import styles from "./StyleGuide.module.css";
import { Tabs } from "./Tabs";
import { TextArea } from "./TextArea";
import { TextInput } from "./TextInput";
import { ToastProvider, useToast } from "./Toast";
import { TopNav } from "./TopNav";
import type { NavItem } from "./nav";

/*
 * Dev-only living style guide (WP-0.7). WP-0.6 mounts it at `/_ui` in dev
 * builds only, inside the router (Button `to` needs router context):
 *   { path: "/_ui", lazy: () => import("../shared/ui/StyleGuide") }   // import.meta.env.DEV only
 */

const NAV_ITEMS: NavItem[] = [
  { key: "inicio", label: "Inicio", href: "/", icon: "🏠", end: true },
  { key: "programa", label: "Programa", href: "/cuencada/2027", icon: "📅" },
  { key: "fotos", label: "Fotos", href: "/galeria", icon: "📸" },
  { key: "chat", label: "Chat", href: "/chat", icon: "💬", badge: 3, badgeLabel: "3 mensajes sin leer" },
  { key: "mas", label: "Más", href: "/_ui", icon: "☰" }
];

const FAMILY = [
  "Jorge Cuenca Fafutis",
  "María de la Luz Cuenca",
  "Rosa Elena Cuenca",
  "Tomás Cuenca",
  "Ana Sofía Pérez Cuenca",
  "Luis Fernando Cuenca",
  "Carmen Cuenca",
  "Diego Cuenca Ruiz",
  "Valeria Cuenca",
  "Pedro Cuenca"
].map((name, i) => ({ id: String(i), name, src: i === 1 ? "/images/fotos/foto02.jpg" : undefined }));

const PHOTOS: LightboxItem[] = [
  { id: "f2", type: "image", src: "/images/fotos/foto02.jpg", alt: "Familia Cuenca en Mérida", caption: "Subida por Rosa · 14 sep" },
  { id: "f3", type: "image", src: "/images/fotos/foto03.jpg", alt: "Recorrido de la Cuencada 2026", caption: "Subida por Tomás · 15 sep" },
  { id: "f4", type: "image", src: "/images/fotos/foto04.jpg", alt: "Celebración familiar", caption: "Subida por Carmen · 16 sep" }
];

const START = new Date("2027-09-12T00:00:00-06:00");
const END = new Date("2027-09-17T23:59:59-06:00");

const SWATCHES: Array<[string, string]> = [
  ["--color-primary", "Verde Cuencada"],
  ["--color-primary-strong", "Verde 2"],
  ["--color-accent", "Oro"],
  ["--color-festive", "Bugambilia"],
  ["--color-bg", "Crema"],
  ["--color-text", "Tinta"],
  ["--color-text-muted", "Texto suave"],
  ["--color-surface-inverse", "Pie de página"],
  ["--color-success", "Éxito"],
  ["--color-danger", "Error"],
  ["--color-whatsapp", "WhatsApp"],
  ["--color-focus-halo", "Halo de foco"]
];

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }): React.ReactNode {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={styles.section}>
      <h2 id={`${id}-title`} className={styles.sectionTitle}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ToastDemo(): React.ReactNode {
  const toast = useToast();
  return (
    <div className={styles.row}>
      <Button variant="secondary" size="sm" onClick={() => toast.show({ message: "¡Listo! Confirmaste tu asistencia.", tone: "success" })}>
        Toast de éxito
      </Button>
      <Button variant="secondary" size="sm" onClick={() => toast.show({ message: "Foto eliminada.", action: { label: "Deshacer", onClick: () => {} } })}>
        Toast con acción
      </Button>
      <Button variant="secondary" size="sm" onClick={() => toast.show({ message: "No pudimos subir la foto. Revisa tu conexión e inténtalo otra vez.", tone: "danger" })}>
        Toast de error
      </Button>
    </div>
  );
}

function StyleGuideContent(): React.ReactNode {
  const now = useNow();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  return (
    <PageShell
      layout="bleed"
      header={
        <TopNav
          items={NAV_ITEMS}
          currentPath="/_ui"
          actions={
            <Button size="sm" variant="secondary">
              Entrar
            </Button>
          }
        />
      }
      bottomNav={<BottomNav items={NAV_ITEMS} currentPath="/_ui" />}
      footer={
        <footer className={styles.footer}>
          <strong>CUENCADA · Portal familiar</strong>
          <p>Una familia. Una historia. Una celebración.</p>
        </footer>
      }
    >
      <header className={`cu-hero-surface cu-papel-picado ${styles.hero}`}>
        <div className="cu-container">
          <p className="cu-kicker">Mérida · Yucatán · 12—17 septiembre 2027</p>
          <h1 className={styles.display}>CUENCADA</h1>
          <p className={styles.heroLead}>Una familia. Una historia. Una celebración.</p>
          <div className={styles.row}>
            <Button icon="📅">Ver programa</Button>
            <Button variant="secondary" surface="dark" icon="📸">
              Subir fotos
            </Button>
            <Button variant="ghost" surface="dark" icon="🗺️">
              Ver lugares
            </Button>
            <Button variant="whatsapp" icon="💬" href="https://chat.whatsapp.com/IvI6oayIIoEJ8Wn7EWQxO0?s=cl&p=i&mlu=0" external>
              Grupo WhatsApp
            </Button>
          </div>
          <Countdown target={START} now={now} end={END} className={styles.heroCountdown} />
        </div>
      </header>

      <div className="cu-container">
        <p className={styles.intro}>
          Guía de estilo viva del sistema de diseño de la Cuencada. Solo existe en desarrollo (<code>/_ui</code>). Todo se diseña primero a 360–414px.
        </p>

        <Section id="color" title="Color">
          <ul className={styles.swatches}>
            {SWATCHES.map(([token, name]) => (
              <li key={token} className={styles.swatch}>
                <span className={styles.chip} style={{ background: `var(${token})` }} />
                <span>
                  <strong>{name}</strong>
                  <code>{token}</code>
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="tipografia" title="Tipografía">
          <div className={styles.stack}>
            <p className={styles.display}>Cuencada</p>
            <h1>Cuencada 2027 en Mérida</h1>
            <h2>Programa de la Cuencada</h2>
            <h3>Cenote &amp; Izamal</h3>
            <h4>Lunes 13 · 7:40 AM reunión</h4>
            <p>
              Texto base a 16px. Durante la Cuencada podrás consultar rápidamente qué actividades están programadas por día, qué sigue, cómo llegar a cada lugar y compartir tus
              fotografías y videos.
            </p>
            <p className={styles.muted}>
              <small>Texto secundario a 14px: Subida por Rosa · hace 2 horas</small>
            </p>
          </div>
        </Section>

        <Section id="botones" title="Botones">
          <div className={styles.stack}>
            <div className={styles.row}>
              <Button>Confirmar asistencia</Button>
              <Button variant="secondary">Ver álbum</Button>
              <Button variant="ghost">Cancelar</Button>
              <Button variant="whatsapp" icon="💬">
                WhatsApp
              </Button>
              <Button variant="danger">Eliminar foto</Button>
            </div>
            <div className={styles.row}>
              <Button size="sm">Pequeño (44px)</Button>
              <Button size="md">Mediano (48px)</Button>
              <Button size="lg">Grande (56px)</Button>
            </div>
            <div className={styles.row}>
              <Button icon="📤">Con icono</Button>
              <Button loading>Guardando…</Button>
              <Button disabled>Deshabilitado</Button>
              <Button variant="secondary" to="/cuencada/2027" iconEnd="›">
                Enlace interno
              </Button>
              <Button variant="ghost" href="https://www.google.com/maps/search/?api=1&query=Izamal+Yucatan" external icon="🗺️">
                Abrir en Google Maps
              </Button>
            </div>
            <Button fullWidth size="lg" icon="✅">
              Ancho completo (acción principal en móvil)
            </Button>
            <div className={styles.row}>
              <IconButton label="Compartir" icon="🔗" />
              <IconButton label="Más opciones" icon="⋯" variant="plain" />
              <IconButton label="Enviar mensaje" icon="➤" variant="solid" />
              <IconButton label="Añadir foto" icon="＋" size="lg" variant="solid" />
              <IconButton label="Deshabilitado" icon="✕" disabled />
            </div>
          </div>
        </Section>

        <Section id="insignias" title="Insignias">
          <div className={styles.row}>
            <Badge>🚌 Transporte incluido</Badge>
            <Badge tone="accent">Solo miembros</Badge>
            <Badge tone="success">Confirmado</Badge>
            <Badge tone="festive">¡Nuevo!</Badge>
            <Badge tone="neutral">Borrador</Badge>
            <Badge tone="danger">Reportada</Badge>
            <Badge shape="count" tone="festive" srLabel="12 mensajes sin leer">
              {12}
            </Badge>
            <Badge shape="count" tone="brand" srLabel="Más de 99 fotos nuevas">
              {140}
            </Badge>
            <Badge shape="dot" tone="festive" srLabel="Novedades" />
          </div>
        </Section>

        <Section id="tarjetas" title="Tarjetas">
          <div className={styles.grid}>
            <Card icon="📅" title="Programa">
              <p>Consulta cada día, horarios y actividades.</p>
            </Card>
            <Card icon="📸" title="Álbum vivo">
              <p>Comparte y consulta las fotos de la familia.</p>
            </Card>
            <Card icon="🗺️" title="¿Dónde estamos?">
              <p>Accesos rápidos a hoteles y lugares del recorrido.</p>
            </Card>
            <Card tone="brand" padding="lg" title="📸 ¡Sube tus fotos y videos!">
              <p>Comparte los momentos de la Cuencada con toda la familia.</p>
              <Button icon="📤">Subir fotos y videos</Button>
            </Card>
            <Card tone="accent" title="💡 Consejo">
              <p>Protector solar, sombrero y agua. Lleva un abanico y una mascada para el aire acondicionado.</p>
            </Card>
            <Card tone="sunken" title="Mensaje del día">
              <p>“Hoy es un buen día para abrazar a alguien de la familia.”</p>
            </Card>
          </div>
        </Section>

        <Section id="formularios" title="Formularios">
          <form className={styles.form} onSubmit={(e) => e.preventDefault()}>
            <Field label="Correo electrónico" hint="Te enviaremos un enlace para entrar sin contraseña." required>
              {(p) => <TextInput {...p} type="email" inputMode="email" autoComplete="email" placeholder="nombre@correo.com" />}
            </Field>
            <Field label="Contraseña" error="La contraseña debe tener al menos 12 caracteres." required>
              {(p) => <TextInput {...p} type="password" autoComplete="current-password" defaultValue="corta" />}
            </Field>
            <Field label="Teléfono" showOptional hint="Solo lo verá la familia si activas la opción.">
              {(p) => <TextInput {...p} type="tel" inputMode="tel" autoComplete="tel" />}
            </Field>
            <Field label="Rama familiar">
              {(p) => (
                <Select
                  {...p}
                  placeholder="Elige una rama"
                  options={[
                    { value: "jorge", label: "Familia de Jorge" },
                    { value: "rosa", label: "Familia de Rosa" },
                    { value: "tomas", label: "Familia de Tomás" }
                  ]}
                />
              )}
            </Field>
            <Field label="Mensaje para la familia" showOptional>
              {(p) => <TextArea {...p} placeholder="Comparte un recuerdo o unas palabras…" />}
            </Field>
            <Field label="Campo deshabilitado">{(p) => <TextInput {...p} disabled defaultValue="admin@cuencada.com" />}</Field>
            <Checkbox label="Voy con acompañantes" hint="Podrás indicar cuántos en el siguiente paso." />
            <Checkbox label="Acepto que mis fotos se compartan con la familia" defaultChecked />
            <Checkbox label="Casilla con error" error="Debes aceptar para continuar." />
            <Switch label="Mostrar mi teléfono a la familia" defaultChecked />
            <Switch label="Recibir avisos por correo" />
            <Switch label="Interruptor deshabilitado" disabled />
            <Button type="submit" fullWidth>
              Guardar cambios
            </Button>
          </form>
        </Section>

        <Section id="avatares" title="Avatares y círculos de asistentes">
          <div className={styles.stack}>
            <div className={styles.row}>
              <AvatarCircle name="Jorge Cuenca Fafutis" size="sm" />
              <AvatarCircle name="María de la Luz Cuenca" size="md" src="/images/fotos/foto02.jpg" />
              <AvatarCircle name="Rosa Elena Cuenca" size="lg" highlight />
              <AvatarCircle name="Tomás Cuenca" size="xl" />
              <AvatarCircle name="Foto rota" size="lg" src="/no-existe.jpg" />
            </div>
            <AvatarStack people={FAMILY} max={5} total={48} />
            <AvatarStack people={FAMILY} max={8} layout="grid" size="lg" />
          </div>
        </Section>

        <Section id="pestanas" title="Pestañas">
          <div className={styles.stack}>
            <Tabs
              label="Días del programa"
              items={[
                { id: "dom", label: "Dom 12", content: <p>🌴 Llegada a Mérida. Check-in en el hotel.</p> },
                { id: "lun", label: "Lun 13", content: <p>💦 Cenote &amp; Izamal.</p> },
                { id: "mar", label: "Mar 14", content: <p>🇲🇽 Uxmal + CUENCADA FEST.</p> },
                { id: "mie", label: "Mié 15", content: <p>🌊 Progreso y atardecer.</p> },
                { id: "jue", label: "Jue 16", content: <p>🛍️ Día libre.</p> },
                { id: "vie", label: "Vie 17", content: <p>❤️ Despedida.</p> }
              ]}
            />
            <Tabs
              label="Galería"
              variant="underline"
              items={[
                { id: "todas", label: "Todas", content: <p>Todas las fotos.</p> },
                { id: "mias", label: "Mis fotos", content: <p>Tus fotos.</p> },
                { id: "videos", label: "Videos", content: <p>Videos.</p>, disabled: true }
              ]}
            />
          </div>
        </Section>

        <Section id="cuenta-regresiva" title="Cuenta regresiva">
          <div className={styles.stack}>
            <Countdown target={START} now={now} end={END} surface="light" />
            <div className={`cu-hero-surface ${styles.darkPanel}`}>
              <Countdown target={START} now={START.getTime() + 3_600_000} end={END} />
            </div>
            <Countdown target={START} now={END.getTime() + 1} end={END} surface="light" pastMessage="La Cuencada 2027 ya es parte de nuestra historia. ¡Gracias por venir!" />
          </div>
        </Section>

        <Section id="carga" title="Carga y estados vacíos">
          <div className={styles.stack}>
            <div className={styles.row}>
              <Spinner />
              <Spinner size="lg" label="Subiendo fotos…" />
            </div>
            <Card aria-busy="true">
              <div className={styles.row}>
                <Skeleton shape="circle" />
                <div style={{ flex: 1 }}>
                  <Skeleton lines={3} />
                </div>
              </div>
            </Card>
            <div className={styles.thumbs}>
              <Skeleton shape="block" height="auto" className={styles.thumbSkeleton} />
              <Skeleton shape="block" height="auto" className={styles.thumbSkeleton} />
              <Skeleton shape="block" height="auto" className={styles.thumbSkeleton} />
            </div>
            <EmptyState
              icon="📸"
              title="Todavía no hay fotos"
              description="Sé la primera persona en compartir un momento de esta Cuencada."
              action={<Button icon="📤">Subir fotos y videos</Button>}
            />
            <EmptyState
              tone="lock"
              icon="🔒"
              title="Solo para la familia"
              description="Inicia sesión para ver las fotos, confirmar tu asistencia y platicar con la familia."
              action={
                <>
                  <Button>Entrar</Button>
                  <Button variant="ghost">Tengo una invitación</Button>
                </>
              }
            />
          </div>
        </Section>

        <Section id="superposiciones" title="Diálogo, avisos y visor">
          <div className={styles.stack}>
            <div className={styles.row}>
              <Button variant="secondary" onClick={() => setDialogOpen(true)}>
                Abrir diálogo (RSVP)
              </Button>
              <Button variant="danger" onClick={() => setConfirmOpen(true)}>
                Confirmación destructiva
              </Button>
            </div>
            <ToastDemo />
            <ul className={styles.thumbs}>
              {PHOTOS.map((photo, i) => (
                <li key={photo.id}>
                  <button type="button" className={styles.thumb} onClick={() => setLightboxIndex(i)} aria-label={`Ver foto: ${photo.alt}`}>
                    <img src={photo.src} alt="" loading="lazy" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      </div>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="¿Vas a la Cuencada 2027?"
        description="Confirma antes del 15 de agosto para apartar transporte y comida."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Ahora no
            </Button>
            <Button onClick={() => setDialogOpen(false)}>Sí, voy</Button>
          </>
        }
      >
        <div className={styles.stack}>
          <Field label="¿Cuántas personas van contigo?" hint="Sin contarte a ti.">
            {(p) => <TextInput {...p} type="number" inputMode="numeric" min={0} max={10} defaultValue={0} />}
          </Field>
          <Field label="Alergias o necesidades" showOptional>
            {(p) => <TextArea {...p} rows={3} />}
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        role="alertdialog"
        closeOnBackdrop={false}
        title="¿Eliminar esta foto?"
        description="Se quitará del álbum para toda la familia. No se puede deshacer."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={() => setConfirmOpen(false)}>
              Eliminar foto
            </Button>
          </>
        }
      />

      <Lightbox items={PHOTOS} index={lightboxIndex} onIndexChange={setLightboxIndex} onClose={() => setLightboxIndex(null)} />
    </PageShell>
  );
}

/** Dev-only living style guide rendering every primitive in its states. Mount at `/_ui` in dev. */
export function StyleGuide(): React.ReactNode {
  return (
    <ToastProvider>
      <StyleGuideContent />
    </ToastProvider>
  );
}

/** react-router `lazy()` convention. */
export { StyleGuide as Component };
export default StyleGuide;
