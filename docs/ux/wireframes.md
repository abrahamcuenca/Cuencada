# Cuencada wireframes (mobile-first)

Owner: UI/UX (WP-0.7). Every frame is drawn at **375px** (about 40 monospace columns). Each screen ends with a **≥900px** note describing how it changes. The components named here are the primitives in `apps/web/src/shared/ui` (see [`design-system.md`](design-system.md)). Spanish copy is final unless marked _(borrador)_. Legacy wording from `index.html` is kept where it exists.

Legend: `[ Botón ]` = Button (gold unless noted) · `( Botón )` = secondary/ghost · `(✕)` = IconButton · `▢` = input · `☐/☑` = checkbox · `⏻` = switch · `◯` = avatar · `▒` = skeleton/photo · `🔒` = members-only.

---

## 0. Global chrome

### 0.1 App bar + bottom tab bar (every page under 900px)
```
┌──────────────────────────────────────┐ ← safe-area-top
│ [▣] CUENCADA                ( Entrar )│  TopNav (brand only <900px)
├──────────────────────────────────────┤
│                                      │
│              page content            │
│                                      │
│                                      │  PageShell pads 64px + safe-bottom
├──────────────────────────────────────┤
│  🏠      📅       📸      💬³     ☰   │  BottomNav (fixed, blurred)
│ Inicio Programa  Fotos   Chat    Más  │  active = gold pill + bold
└──────────────────────────────────────┘ ← safe-area-bottom (home indicator)
```
- **Programa** points to the current or next edition: `/cuencada/{año}`.
- **Fotos** points to `/galeria/{año}`.
- **Chat** shows a bugambilia unread badge. Its accessible label reads "Chat, 3 mensajes sin leer".
- Signed-out visitors still see the tab bar.
  - Fotos and Chat lead to the 🔒 lock state with an "Entrar" button. Nothing is hidden.
- The "Entrar" button in the app bar becomes an avatar `◯` once signed in, and opens the **Más** sheet.

### 0.2 "Más" sheet (Dialog, bottom sheet)
```
┌──────────────────────────────────────┐
│               ───                    │ grabber
│ Más                              (✕) │
│ ◯ Rosa Cuenca · Ver mi perfil      › │
│ ──────────────────────────────────── │
│ 🧭 Directorio                      › │
│ 🌳 Árbol familiar                  › │
│ 📜 Cuencadas anteriores            › │
│ 💬 Grupo WhatsApp ↗                  │ (external, legacy link)
│ ⭐ Administración                  › │ (admins only)
│ ──────────────────────────────────── │
│ 🔐 Sesiones y seguridad            › │
│ ( Cerrar sesión )                    │
└──────────────────────────────────────┘
```
- **≥900px:** The sheet becomes the account menu, a dropdown from the avatar in the TopNav. Directorio and Árbol become inline TopNav links.

### 0.3 TopNav at ≥900px
```
[▣] CUENCADA     Inicio  Programa  Fotos  Chat³  Directorio  Árbol    ◯ ▾
```

---

## 1. Home `/`

The status is calculated from dates in the Cuencada's timezone:
- **upcoming:** an edition is published and hasn't ended yet. Live mode covers the dates of the event.
- **memories:** no future edition is published. This is the case today, because 2026 is over.

### 1.1 Upcoming / live mode
```
┌──────────────────────────────────────┐
│ [▣] CUENCADA                ( Entrar )│ (TopNav surface="hero", transparent)
│░░░░░░░░░░░ green hero gradient ░░░░░░│
│ MÉRIDA · YUCATÁN · 13—18 SEPT 2026   │ .cu-kicker (gold-300)
│ CUENCADA                             │ --text-display, white
│ Una familia. Una historia.           │
│ Una celebración.                     │
│                                      │
│ [ 📅 Ver programa                  ] │ fullWidth gold
│ ( 📸 Subir fotos ) ( 🗺️ Ver lugares ) │ secondary/ghost on dark
│ [ 💬 Grupo WhatsApp ] (ink on green) │
│ ┌──────┬──────┬──────┬──────┐        │ Countdown (dark)
│ │ 342  │  08  │  25  │  10  │        │
│ │ días │horas │minut.│segun.│        │
│ └──────┴──────┴──────┴──────┘        │
│◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠│ papel picado edge
│ 💌 Mensaje del día                   │ Card sunken (only if one exists today)
│ "Hoy es un buen día para…"           │
│                                      │
│ Todo en un solo lugar                │ h2
│ ┌──────────────────────────────────┐ │
│ │ 📅 Programa                    › │ │ compact list-cards on mobile
│ │ Consulta cada día, horarios…     │ │ (1 column)
│ ├──────────────────────────────────┤ │
│ │ 📸 Álbum vivo                  › │ │
│ │ 🗺️ ¿Dónde estamos?             › │ │
│ │ 🌤️ Clima en Mérida             › │ │
│ │ 🎵 Nuestra canción             › │ │
│ │ ❤️ Nuestra familia             › │ │
│ │ 🎒 Tips Cuencada               › │ │
│ └──────────────────────────────────┘ │
│ ¿Vas a ir?  ◯◯◯◯◯ +43                │ AvatarStack (🔒 members) or lock teaser
│ [ ✅ Confirmar asistencia ]          │
├──────────────────────────────────────┤
│ footer #153c36                       │
│ CUENCADA 2026 · MÉRIDA, YUCATÁN      │
└──────────────────────────────────────┘
```
- **Live (between start and end):** The countdown becomes the gold "🎉 ¡YA LLEGÓ LA CUENCADA! 🎉" block. Below it, a **"Hoy"** card shows today's programa day with "Ahora" and "Sigue" lines. This is the most useful screen during the trip.
- **≥900px:** Hero CTAs sit in a single row and the countdown sits inline under them (like the legacy page). Feature cards become a 3-column grid of full cards with icon, title and text. RSVP and attendees sit in a 2-column band.

### 1.2 Memories mode (no upcoming edition)
```
┌──────────────────────────────────────┐
│ [▣] CUENCADA                ( Entrar )│
│░░░░░░░░░░░ green hero ░░░░░░░░░░░░░░░│
│ GRACIAS POR UNA CUENCADA INOLVIDABLE │ kicker
│ CUENCADA                             │
│ Una familia. Una historia.           │
│ Una celebración.                     │
│ ┌──────────────────────────────────┐ │
│ │ 💛 La Cuencada 2026 en Mérida ya │ │ Countdown past state
│ │ es parte de nuestra historia.    │ │
│ └──────────────────────────────────┘ │
│ [ 📸 Ver recuerdos de 2026 ]         │
│ ( 📅 Ver programa 2026 )             │
│◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠│
│ Recuerdos de Mérida 2026             │ h2
│ ┌────────┬────────┐                  │ mosaic 2 cols (members: real
│ │ ▒▒▒▒▒▒ │ ▒▒▒▒▒▒ │                  │ photos; guests: 4 public picks
│ ├────────┼────────┤                  │ chosen by admin)
│ │ ▒▒▒▒▒▒ │ ▒▒▒▒▒▒ │                  │
│ └────────┴────────┘                  │
│ ( Ver álbum completo )               │
│                                      │
│ La próxima Cuencada                  │ Card accent
│ Todavía no tiene fecha. Te avisaremos│
│ por correo cuando se publique.       │
│                                      │
│ Cuencadas anteriores                 │ horizontal scroll chips
│ ( 2026 Mérida ) ( 2024 … ) ( 2022 … )│
└──────────────────────────────────────┘
```
- **≥900px:** The mosaic shows 5 columns, matching the legacy `.mosaico-fotos`. "La próxima Cuencada" and "Cuencadas anteriores" sit side by side.

---

## 2. Cuencada `/cuencada/:year`

The page is partially public. Hero, programa, lugares, clima, canción and tips are public. Attendees, RSVP and photos are 🔒.

```
┌──────────────────────────────────────┐
│ [▣] CUENCADA                ( Entrar )│
│░░░░░░░░░░░ hero (compact) ░░░░░░░░░░░│
│ MÉRIDA · YUCATÁN · 13—18 SEPT 2026   │
│ Cuencada 2026                        │ --text-3xl
│ Del domingo 13 al viernes 18 de      │
│ septiembre.                          │
│ [ 💬 Grupo WhatsApp ] ( 🔍 Programa  │
│                         completo ↗ ) │ (legacy OneDrive link)
│ Countdown (or live / past state)     │
│◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠◠│
│ ┌ 💌 Mensaje del día ──────────────┐ │ only on dates with a message
│ │ "…"                              │ │
│ └──────────────────────────────────┘ │
│ ( Programa )( Lugares )( Clima )( Ca…│ sticky section Tabs-as-anchors,
│                                      │ scrolls sideways
│ 📅 Programa                          │
│ ( Dom 13 )( Lun 14 )( Mar 15 )( Mi…) │ Tabs pill: one day at a time
│ ┌──────────────────────────────────┐ │
│ │ 14  LUNES                        │ │ Card as="article"
│ │ 💦 Cenote & Izamal               │ │
│ │ $1,000 p/p                       │ │
│ │ ● 7:40 AM  Reunión               │ │ timeline rows
│ │ ● 8:00 AM  Salida puntual        │ │
│ │ ● 9:00 AM  Cenote Santa Bárbara  │ │
│ │ ● 1:00 PM  Comida yucateca       │ │
│ │ ● 3:00 PM  Izamal                │ │
│ │ ● 6:00 PM  Regreso al hotel      │ │
│ │ (🚌 Transporte incluido)(💦 Ce…) │ │ Badges
│ └──────────────────────────────────┘ │
│                                      │
│ 🗺️ ¿Dónde estamos?                   │
│ ┌──────────────────────────────────┐ │
│ │ 🏨 Hotel Chariot Mérida          │ │
│ │ Uno de los hoteles base…         │ │
│ │ ( Abrir sitio del hotel ↗ )      │ │
│ └──────────────────────────────────┘ │
│ ┌ 💦 Cenote Santa Bárbara ─────────┐ │
│ │ Actividad del lunes 14.          │ │
│ │ ( 🗺️ Abrir en Google Maps ↗ )    │ │
│ └──────────────────────────────────┘ │
│                                      │
│ 🌤️ Clima en Mérida                   │ weatherwidget.io (lazy, below fold)
│ ┌──────────────────────────────────┐ │
│ │  [widget]                        │ │
│ └──────────────────────────────────┘ │
│ 🎵 Nuestra canción                   │
│ ┌──────────────────────────────────┐ │
│ │ ▶ ━━━━━━━━○──── 1:12 / 3:40      │ │ native <audio controls>
│ │ ( 📖 Ver letra oficial ↗ )       │ │
│ └──────────────────────────────────┘ │
│                                      │
│ 👨‍👩‍👧‍👦 ¿Quién va?                       │
│ ◯◯◯◯◯◯◯◯ +43   48 confirmados        │ AvatarStack grid, tap → sheet list
│ ┌ RSVP ────────────────────────────┐ │ Card accent
│ │ ¿Vas a la Cuencada 2026?         │ │
│ │ Confirma antes del 15 de agosto. │ │
│ │ [ Sí, voy ]   ( No podré ir )    │ │
│ └──────────────────────────────────┘ │
│ 📸 Álbum vivo  →  /galeria/2026      │
│ 🎒 Tips · ⭐ Actividades extras       │ accordions on mobile
└──────────────────────────────────────┘
```
- **RSVP states:**
  - Not answered: shown above.
  - **Confirmado:** "✅ ¡Vas! Tú + 2 acompañantes" with "( Cambiar respuesta )".
  - **No voy:** "Te vamos a extrañar 💛" with "( Cambiar respuesta )".
  - **Cerrado** (after `rsvp_deadline`): "Las confirmaciones cerraron el 15 de agosto. Escribe en el grupo de WhatsApp si cambiaron tus planes."
  - "Sí, voy" opens the RSVP **Dialog** (bottom sheet). It asks for the number of companions (`inputMode="numeric"`) and alergias o necesidades (optional). Actions are "( Ahora no )" and "[ Sí, voy ]". The success toast reads "¡Listo! Confirmaste tu asistencia."
- **Members-only lock**, which replaces "¿Quién va?", the RSVP card and the photo strip for visitors:
```
┌ - - - - - - - - - - - - - - - - - - ┐  EmptyState tone="lock"
│                🔒                    │
│        Solo para la familia          │
│ Inicia sesión para ver quién va,     │
│ confirmar tu asistencia y ver las    │
│ fotos.                               │
│          [ Entrar ]                  │
│     ( Tengo una invitación )         │
└ - - - - - - - - - - - - - - - - - - ┘
```
- **≥900px:**
  - Programa shows **all days as a vertical timeline**: a 110px date column plus the content, matching the legacy `.day`. Tabs are not used.
  - Lugares becomes a 2-column grid.
  - Clima and Canción sit side by side.
  - The RSVP card and attendees become a sticky right rail (`grid-template-columns: 1fr 360px`).

---

## 3. Auth (T1)

All auth screens use the same single-column card on cream: brand at the top, the form, then a secondary link. Under 900px they have no BottomNav, only a back `(‹)`.

### 3.1 Entrar `/entrar`
```
┌──────────────────────────────────────┐
│ (‹)                                  │
│            [▣ logo 72]               │
│ Entrar a la Cuencada                 │ h1
│ ( Con enlace )( Con contraseña )     │ Tabs pill (enlace default)
│                                      │
│ Correo electrónico                   │ Field
│ Te enviaremos un enlace para entrar  │ hint
│ sin contraseña.                      │
│ ▢ nombre@correo.com                  │ type=email inputmode=email
│                                      │ autocomplete=email
│ [ Enviar enlace                    ] │ fullWidth
│                                      │
│ ¿Recibiste una invitación? Ábrela    │
│ desde tu correo para crear tu cuenta.│
└──────────────────────────────────────┘
```
- **"Con contraseña" tab:**
  - "Correo electrónico"
  - "Contraseña", with a show/hide `IconButton` 👁 ("Mostrar contraseña") and `autocomplete=current-password`
  - "[ Entrar ]"
  - the link "¿Olvidaste tu contraseña?"
- **Errors:**
  - Wrong credentials: "El correo o la contraseña no coinciden. Revisa e inténtalo otra vez." This message is identical for unknown emails, so it doesn't reveal whether an account exists.
  - Rate-limited: "Demasiados intentos. Espera unos minutos y vuelve a intentarlo."
- **Enlace enviado** state, which replaces the form:
  - "📬 Revisa tu correo"
  - "Si {correo} tiene una cuenta, te enviamos un enlace para entrar. Caduca en 15 minutos."
  - "( Usar otro correo )"
- **Magic-link landing** `/entrar/enlace?token=…`:
  - A spinner with "Entrando…"
  - Then a redirect, or the error "Este enlace ya se usó o caducó. Pide uno nuevo." with "[ Pedir otro enlace ]".
- **≥900px:** The page splits 50/50. The left half is the green hero panel with the papel picado edge and "Una familia. Una historia. Una celebración."; the form card sits on the right.

### 3.2 Invitación `/invitacion?token=…`
```
│ 💌 Te invitaron a la Cuencada        │
│ Jorge Cuenca te invitó a unirte al   │
│ portal de la familia.                │
│ Nombre completo        ▢ (autocomplete=name)
│ Correo electrónico     ▢ (readonly, prefilled from invite)
│ Crea una contraseña    ▢ (new-password)
│ Al menos 12 caracteres. Usa una frase│ hint
│ que recuerdes.                       │
│ Confirma tu contraseña ▢             │
│ ☐ Acepto que mis fotos y datos se    │
│   compartan solo con la familia.     │
│ [ Crear mi cuenta                  ] │
```
- **Invalid or expired invite:** "Esta invitación ya no es válida. Pide a quien te invitó que te mande una nueva."
- **Success toast:** "¡Bienvenida/o a la familia!" The user then lands on Home.

### 3.3 Recuperar `/recuperar`, Restablecer `/restablecer?token=…`
- **Recuperar:**
  - "¿Olvidaste tu contraseña?"
  - "Escribe tu correo y te enviaremos un enlace para crear una nueva."
  - "[ Enviar enlace ]"
  - Then: "Si el correo tiene cuenta, te llegará un enlace en unos minutos."
- **Restablecer:**
  - "Nueva contraseña" and "Confirma tu contraseña"
  - "[ Guardar contraseña ]"
  - Toast: "Contraseña actualizada. Ya puedes entrar."
  - Mismatched passwords: "Las contraseñas no coinciden."

### 3.4 Cambio obligatorio `/cambiar-contrasena`
```
│ 🔐 Cambia tu contraseña              │
│ Por seguridad, crea una contraseña   │
│ nueva antes de continuar.            │
│ Contraseña temporal    ▢ current-password
│ Nueva contraseña       ▢ new-password │
│ Confirma la nueva      ▢             │
│ [ Guardar y continuar              ] │
│ ( Cerrar sesión )                    │
```
- This screen has no BottomNav and no way out except saving or logging out, because the API returns 403 `PASSWORD_CHANGE_REQUIRED` everywhere else.

### 3.5 Sesiones `/perfil/sesiones`
```
│ Sesiones activas                     │
│ ┌ 📱 iPhone · Safari  (Esta sesión) ┐│
│ │ Mérida · hace 2 min              ││
│ └──────────────────────────────────┘│
│ ┌ 💻 Windows · Chrome               ┐│
│ │ Monterrey · hace 3 días  ( Cerrar )│
│ └──────────────────────────────────┘│
│ ( Cerrar todas las demás sesiones )  │ → alertdialog confirm
```

---

## 4. Perfil `/perfil` (🔒, T5)
```
┌──────────────────────────────────────┐
│ (‹) Mi perfil                        │
│        ◯ 96 (foto)   ( 📷 Cambiar )  │ input accept="image/*"
│ Rosa Elena Cuenca                    │
│ Rama: Familia de Jorge               │
│ ──────────────────────────────────── │
│ Nombre completo        ▢             │
│ Cómo te dicen          ▢ (opcional)  │
│ Ciudad                 ▢ (opcional)  │ autocomplete=address-level2
│ Teléfono               ▢ (opcional)  │ type=tel
│ Fecha de nacimiento    ▢ (opcional)  │ type=date
│ Sobre mí               ▢▢ (opcional) │ TextArea
│ ──────────────────────────────────── │
│ ¿Quién puede ver mis datos?          │ h2
│ ⏻ Mostrar mi teléfono a la familia   │ Switch
│ ⏻ Mostrar mi correo a la familia     │
│ ⏻ Mostrar mi cumpleaños              │
│ Tus datos solo los ve la familia con │ hint
│ sesión iniciada.                     │
│ [ Guardar cambios                  ] │ sticky above BottomNav when dirty
│ 🔐 Sesiones y seguridad            › │
└──────────────────────────────────────┘
```
- **Toast:** "Cambios guardados."
- **Avatar upload:** a progress ring on the avatar. If it fails: "No pudimos subir la foto. Inténtalo otra vez."
- **≥900px:** Two columns, with the avatar card on the left (sticky) and the form plus privacy on the right.

---

## 5. Directorio `/directorio` (🔒, T5)
```
┌──────────────────────────────────────┐
│ Directorio                           │ h1
│ ▢ 🔎 Buscar por nombre o ciudad      │ type=search, sticky under app bar
│ ( Todas las ramas ▾ )( Fue a 2026 ☐ )│ filter chips → Select sheet
│ 128 familiares                       │ muted count
│ ┌──────────────────────────────────┐ │
│ │ ◯ Rosa Elena Cuenca            › │ │ list rows, 64px
│ │   Mérida · Familia de Jorge      │ │
│ ├──────────────────────────────────┤ │
│ │ ◯ Tomás Cuenca                 › │ │
│ │   Monterrey · Familia de Tomás   │ │
│ └──────────────────────────────────┘ │
│ … (infinite scroll, Skeleton rows)   │
└──────────────────────────────────────┘
```
- **Person detail** (a sheet on mobile, a side panel at 900px and up):
  - avatar 96, name, rama
  - "📞 Llamar", "💬 WhatsApp" and "✉️ Correo", **only for the fields the person made visible**
  - "🌳 Ver en el árbol"
- **Empty search:** "🔎 No encontramos a nadie con "{q}". Revisa la ortografía o quita filtros." with "( Quitar filtros )".
- **≥900px:** The list sits on the left (360px) and the detail on the right. Filters move to a left sidebar at 1200px and up.

---

## 6. Árbol familiar `/arbol/:personId?` (🔒, T6)

A person-centred view with tap-to-navigate. No pan or zoom canvas.
```
┌──────────────────────────────────────┐
│ Árbol familiar        ( 🔎 Buscar )  │
│ Padres                               │
│   ◯ Francisco      ◯ Amada           │ tap → becomes centre
│          ╲        ╱                  │
│ ┌──────────────────────────────────┐ │
│ │        ◯ 96  (gold ring)         │ │ focus person card
│ │     Jorge Cuenca Fafutis         │ │
│ │     1952 · Mérida                │ │
│ │  ( Ver perfil )  ( ✏️ Editar )   │ │ edit only self/admin
│ └──────────────────────────────────┘ │
│ Pareja                               │
│   ◯ Carmen Ruiz                      │
│ Hijos (3)                            │
│   ◯ Rosa   ◯ Tomás   ◯ Luis          │ horizontal scroll if many
│ Hermanos (4)                       › │ collapsed row
│ ‹ Volver a: Francisco Cuenca         │ breadcrumb trail (history)
└──────────────────────────────────────┘
```
- People without accounts show initials and the label "Sin cuenta".
- **Empty state:** "🌳 Todavía no hay árbol. Un administrador puede empezar a agregar a la familia."
- **≥900px:** Three bands (padres / persona / hijos) laid out horizontally with SVG connector lines. Pareja sits beside the focus card and the search stays visible.

---

## 7. Galería `/galeria/:year` (🔒, T4)

### 7.1 Grid
```
┌──────────────────────────────────────┐
│ Álbum vivo 2026            ( ⋯ )     │
│ ( Todas )( Por día ▾ )( Mis fotos )  │ Tabs underline
│ Lunes 14 · 32 fotos                  │ sticky day header
│ ┌──────┬──────┬──────┐               │ 3 cols, 2px gaps, square WebP
│ │ ▒▒▒▒ │ ▒▒▒▒ │ ▒▶▒▒ │               │ ▶ = video badge
│ ├──────┼──────┼──────┤               │
│ │ ▒▒▒▒ │ ▒▒▒▒ │ ▒▒▒▒ │               │
│ └──────┴──────┴──────┘               │
│                               ( ＋ ) │ FAB 56px "Subir fotos y videos",
│                                      │ above BottomNav + safe area
└──────────────────────────────────────┘
```
- Tapping a thumbnail opens the **Lightbox**:
  - counter "3 de 32"
  - swipe left and right
  - caption "Subida por Rosa · 14 sep"
  - actions: "( ⬇ Descargar )" and "( ⚑ Reportar )"
- **Reportar** opens a sheet:
  - "¿Por qué quieres reportar esta foto?"
  - Radios: "No debería estar aquí", "Aparezco yo y no quiero", "Otro".
  - "[ Enviar reporte ]"
  - Toast: "Gracias. Un administrador la revisará."

### 7.2 Upload (FAB → native picker `accept="image/*,video/*" multiple`)
```
┌ Subiendo 3 de 8 ─────────────────────┐ sticky card above BottomNav
│ ▒ IMG_2041.jpg   ━━━━━━━━━━──  72%  (✕)│ per-file progress
│ ▒ IMG_2042.mov   ━━━──────────  18%  (✕)│
│ ▒ IMG_2043.jpg   En espera…           │
│ ✅ 2 listas · ⚠️ 1 falló ( Reintentar )│
└──────────────────────────────────────┘
```
- Per-file states:
  - En espera…
  - Subiendo {n}%
  - Procesando… (sharp)
  - ✅ Lista
  - ⚠️ "No se pudo subir. ( Reintentar )"
- Too large: "Este video pesa más de 200 MB. Recórtalo o súbelo desde una computadora." _(the limit is borrador; it depends on the server config)_
- Wrong type: "Solo se pueden subir fotos y videos."
- The card can be minimised to a pill "⬆ 3 de 8". Uploads continue while you browse within the app.

### 7.3 Empty
```
│ ┌ - - - - - - - - - - - - - - - - ┐ │
│ │            📸                     │ │
│ │   Todavía no hay fotos            │ │
│ │ Sé la primera persona en compartir│ │
│ │ un momento de esta Cuencada.      │ │
│ │ [ 📤 Subir fotos y videos ]       │ │
│ └ - - - - - - - - - - - - - - - - ┘ │
```
- **≥900px:** The grid shows 5 columns at 900px and 6 at 1200px. Upload becomes a header button plus drag-and-drop over the grid ("Suelta tus fotos aquí"). The progress card docks bottom-right. The lightbox gets side arrows and a caption bar.

---

## 8. Chat `/chat` (🔒, T7)

### 8.1 Room list
```
┌──────────────────────────────────────┐
│ Chat                                 │
│ ┌──────────────────────────────────┐ │
│ │ 👨‍👩‍👧‍👦 Toda la familia        ³ 9:41│ │ unread count badge (festive)
│ │   Rosa: ¿Alguien trae bloqueador?│ │ last message, 1 line
│ ├──────────────────────────────────┤ │
│ │ 🌴 Cuencada 2026              ayer│ │
│ │   Tomás: 📷 Foto                 │ │
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

### 8.2 Conversation (full screen; BottomNav hidden, so the composer owns the bottom)
```
┌──────────────────────────────────────┐
│ (‹) Toda la familia · 128            │ app bar
│ ── Lunes 14 de septiembre ──         │ day divider
│ ◯ Rosa                               │
│   ┌────────────────────────┐         │ others: white bubble, left
│   │ ¿Alguien trae bloquea- │         │
│   │ dor? ☀️           9:41 │         │
│   └────────────────────────┘         │
│         ┌────────────────────────┐   │ mine: green-soft, right
│         │ ¡Yo! Te veo en el lobby│   │
│         │                   9:42 ✓│   │
│         └────────────────────────┘   │
│ ── Nuevos mensajes ──                │ unread marker
│            ( ↓ 3 nuevos )            │ jump pill when scrolled up
├──────────────────────────────────────┤
│ ▢ Escribe un mensaje…         ( ➤ )  │ composer: sticky bottom,
└──────────────────────────────────────┘ padding-bottom: safe-bottom
```
- **Keyboard:** The composer sits on the visual viewport, using `interactive-widget=resizes-content` in the viewport meta or a `visualViewport` listener, so it stays **above the keyboard**. The TextArea grows to 5 lines, then scrolls. Enter inserts a newline on mobile; the send button sends. On ≥900px, Enter sends and Shift+Enter adds a newline.
- **Reconnecting banner** (yellow, under the app bar): "Reconectando… Los mensajes se enviarán cuando vuelva la conexión."
- **Failed message:** a red "⚠️ No se envió · Reintentar" under the bubble.
- **Empty room:** "💬 Aún no hay mensajes. ¡Saluda a la familia!"
- **≥900px:** Two panes. The room list is 320px; the conversation fills the rest. The BottomNav is not present at that width anyway.

---

## 9. Admin `/admin` (admins only, T2/T3/T4/T8)

Designed to be **usable on a phone**: lists are cards, editing happens in full-screen sheets, and there are no data tables under 900px.

### 9.1 Shell
```
┌──────────────────────────────────────┐
│ (‹) Administración                   │
│ ( Cuencadas )( Personas )( Fotos )(… │ Tabs scrollable
│ ┌ Pendientes ──────────────────────┐ │ dashboard cards
│ │ ⚑ 2 fotos reportadas           › │ │
│ │ 💌 5 invitaciones sin aceptar  › │ │
│ └──────────────────────────────────┘ │
```
- **Sections:**
  - Cuencadas (incl. itinerario, lugares, mensajes del día, avisos)
  - Asistencia
  - Personas y árbol
  - Invitaciones
  - Usuarios
  - Fotos (moderación)
  - Bitácora (audit log)

### 9.2 List pattern
```
│ Cuencadas                ( ＋ Nueva )│
│ ▢ 🔎 Buscar                          │
│ ┌──────────────────────────────────┐ │
│ │ 2026 · Mérida   (Publicada)    › │ │ Badge success
│ │ 13–18 sep · 48 confirmados       │ │
│ ├──────────────────────────────────┤ │
│ │ 2027 · Oaxaca   (Borrador)     › │ │ Badge neutral
│ └──────────────────────────────────┘ │
```

### 9.3 Edit pattern (full-screen sheet, sticky save bar)
```
┌──────────────────────────────────────┐
│ (✕) Editar Cuencada 2026             │
│ Título              ▢                │
│ Ciudad              ▢                │
│ Fecha de inicio     ▢ type=date      │
│ Fecha de fin        ▢ type=date      │
│ Zona horaria        [America/Merida ▾]│ Select
│ Límite para confirmar ▢ type=date    │
│ Enlace de WhatsApp  ▢ type=url       │
│ Canción (URL)       ▢ type=url       │
│ ⏻ Publicada                          │
│ ──────────────────────────────────── │
│ Itinerario (6 días)              ›   │ nested lists → own sheets
│ Lugares (6)                      ›   │
│ Mensajes del día (6)             ›   │ includes "Importar YYYY-MM-DD|msg"
├──────────────────────────────────────┤
│ ( Cancelar )      [ Guardar cambios ]│ sticky footer + safe area
└──────────────────────────────────────┘
```
- **Leaving with unsaved changes** opens an alertdialog: "¿Salir sin guardar? Perderás los cambios." with "( Seguir editando )" and "[ Salir sin guardar ]" (danger).
- **Asistencia (bulk):** a searchable list of people with a ☐ per row and a sticky bar "12 seleccionadas · [ Marcar como asistentes ]". "( Exportar CSV )" sits in the header.
- **Moderación:** a photo grid with a ⚑ badge on each reported photo. Tap opens the lightbox with the actions "( Ocultar )", "( Restaurar )" and "[ Eliminar ]" (danger + alertdialog).
- **Bitácora:** cards showing "Rosa Cuenca editó «Cuencada 2026» · hace 2 h", with a filter by person and by action.
- **Invitaciones:** "[ ＋ Invitar ]" opens a sheet asking for correo, nombre and rol, then "[ Enviar invitación ]". The list shows each invite's state (Enviada, Aceptada, Caducada) with "( Reenviar )" and "( Revocar )".
- **≥900px:** A left sidebar navigation (240px). Lists become tables with sortable columns. Edit opens as a right-side drawer (560px) rather than full screen.

---

## 10. PWA states (T9)

### 10.1 Update prompt (Toast-style, persistent)
```
│ ┌──────────────────────────────────┐ │ above BottomNav
│ │ ✨ Hay una nueva versión.        │ │
│ │ ( Más tarde )   [ Actualizar ]   │ │
│ └──────────────────────────────────┘ │
```

### 10.2 Offline banner (PageShell `banner`, sticky)
```
├──────────────────────────────────────┤
│ 📴 Sin conexión. Mostramos el último │ warning-soft bg
│ programa guardado.                   │
├──────────────────────────────────────┤
```
- Actions that need the network are disabled and get a hint: "Necesitas conexión para subir fotos."
- The banner then changes to "✅ Conexión recuperada" for 3 seconds.

### 10.3 Install hint (once, after the 2nd visit, dismissible)
- "📲 Agrega la Cuencada a tu pantalla de inicio para abrirla como app." with "( Ahora no )" and "[ Instalar ]".
- On iOS the hint reads "Toca Compartir y luego 'Agregar a inicio'" instead.

---

## 11. Errors and system pages
- **404:** "🧭 No encontramos esta página. Puede que el enlace esté mal escrito." with "[ Ir al inicio ]".
- **403 / lock:** use the `EmptyState tone="lock"` pattern from section 2.
- **Generic error:** "Algo salió mal al cargar esta sección. Recarga la página; si sigue pasando, avísanos en el grupo de WhatsApp." with "[ Recargar ]".
- **Session expired:** a toast "Tu sesión terminó. Entra de nuevo para continuar." followed by a redirect to `/entrar?next=…`.

## 12. Key microcopy glossary

| Concept | Copy |
|---|---|
| Sign in / out | Entrar · Cerrar sesión |
| RSVP | Confirmar asistencia · Sí, voy · No podré ir · Cambiar respuesta |
| Attendees | ¿Quién va? · {n} confirmados · y {n} más |
| Gallery | Álbum vivo · Subir fotos y videos · Ver álbum |
| Places | ¿Dónde estamos? · Abrir en Google Maps · Abrir sitio del hotel |
| Members-only | Solo para la familia · Inicia sesión para ver… |
| Save | Guardar cambios → toast "Cambios guardados." |
| Countdown | días · horas · minutos · segundos · ¡YA LLEGÓ LA CUENCADA! |
| Hero | Una familia. Una historia. Una celebración. |
| Closing | ¡Nos vemos en {ciudad}! · Que esta Cuencada se convierta en otro capítulo de nuestra historia familiar. |
