# Cuencada design system

Owner: UI/UX (WP-0.7). Code: `apps/web/src/shared/styles/` (tokens + base) and `apps/web/src/shared/ui/` (primitives).
Living reference: `apps/web/src/shared/ui/StyleGuide.tsx`, mounted by WP-0.6 at `/_ui` in dev builds only.
Screenshots: [`screenshots/`](screenshots/) (375px and 1280px).

## 1. Principles

1. **The phone in the cenote line is the primary device.** Every screen is designed at 360–414px first. Wider layouts are enhancements added with `min-width` queries only.
2. **Evolve the legacy page, don't replace it.** Keep the green hero gradient, the gold pill buttons, the 24px white cards, the emoji icons and the Spanish wording people already know ("Una familia. Una historia. Una celebración.", "Álbum vivo", "¿Dónde estamos?").
3. **One festive signature, used sparingly.** The *papel picado* scalloped edge (`.cu-papel-picado`) is the one decorative flourish. It goes on the hero and at most one feature panel per page. Everything else stays calm.
4. **Family first, privacy by default.** Photos, RSVPs, attendee circles, chat, directory and the tree are members-only. Lock states explain what's behind them and how to get in. They never just hide content.
5. **Plain, warm Spanish.** Use sentence case, active verbs and the informal *tú*. Errors say what happened and how to fix it, without apologising. Empty states invite the next action.
6. **Fast on 4G.** Use system fonts only (0 KB of webfonts), CSS Modules with no runtime CSS-in-JS, WebP images and lazy routes. The budget is under 200KB gzip of initial JS and LCP under 2.5s.

## 2. Tokens (`shared/styles/tokens.css`)

Load the tokens once in `main.tsx`, before `base.css`. Always use **semantic** tokens in components. The raw `--brand-*` values exist only to define them.

### Colour

| Token | Value | Use | Contrast |
|---|---|---|---|
| `--color-bg` | `#fffaf0` cream | page background | – |
| `--color-surface` | `#ffffff` | cards, sheets, inputs | – |
| `--color-surface-sunken` | `#f4faf7` | empty states, quiet blocks | – |
| `--color-surface-inverse` | `#153c36` | footer, toasts | white 12.1:1 |
| `--color-text` | `#17332f` ink | body text | 13.0:1 on cream |
| `--color-text-muted` | `#60736f` | secondary text | 4.83:1 cream, 5.02:1 white |
| `--color-primary` | `#0b5e55` | links, active nav, primary icons | white 7.65:1 |
| `--color-primary-strong` | `#087f6d` | gradient end, large text | white 4.92:1 |
| `--color-primary-soft` | `#eef7f3` | tags, hover tints | primary 7.0:1 |
| `--color-accent` | `#e7b84b` gold | primary buttons, active-tab underline | ink 7.32:1. **Never use it as text on light** (1.78:1) |
| `--color-accent-on-dark` | `#ffe39a` | kicker and highlights on green | 6.08:1 on primary |
| `--color-accent-text` | `#8c6a12` | gold-family text on light | 4.65:1 on gold-100 |
| `--color-festive` | `#a61b4a` bugambilia | unread badges, "¡Nuevo!" | white 7.3:1 |
| `--color-danger` / `-soft` | `#b3261e` / `#fdecea` | errors, destructive actions | 6.54:1 on white |
| `--color-success` / `-soft` | `#1b6e3a` / `#e6f4ea` | confirmations | 6.29:1 on white |
| `--color-whatsapp` | `#25d366` | WhatsApp button | **ink text** `#0b2e1a` 7.46:1 (white is only 1.98:1) |
| `--color-border-strong` | `#7b8f8a` | input borders | 3.42:1 (≥3:1 non-text) |
| `--color-focus` + `--color-focus-halo` | `#0a3f39` + `#ffe39a` | focus ring | visible on cream, white **and** green |

Bugambilia is new. It's the bougainvillea that covers walls in Mérida, and it gives the palette a festive third note so the unread and "new" states don't compete with gold CTAs.

### Typography
- `--font-body`: the system UI stack.
- `--font-display`: `ui-rounded` / SF Pro Rounded first, which gives a warmer headline on iOS and macOS, then the system stack. No webfonts.
- Fluid scale using `clamp()`, with the minimum at 360px and the maximum at 1200px:

| Token | Range | Use |
|---|---|---|
| `--text-xs` | 12px | tab-bar labels and badges only |
| `--text-sm` | 14px | meta and captions |
| `--text-md` | 16px | body and **all inputs** (prevents iOS zoom) |
| `--text-lg` | 17–20px | lead text |
| `--text-xl` | 20–26px | h3 |
| `--text-2xl` | 26–38px | h2 |
| `--text-3xl` | 34–56px | h1 |
| `--text-display` | 52–118px | the "CUENCADA" wordmark, which keeps the legacy `-0.05em` tracking |

- The uppercase tracked kicker (`.cu-kicker`) is **only** for the hero location line ("MÉRIDA · YUCATÁN · 13—18 SEPTIEMBRE"), as in the legacy page. Don't use it as a generic label.

### Spacing, radii, shadows, layers, motion
- **Spacing:** a 4px base (`--space-1` … `--space-16`). `--gutter` grows from 16px to 24px. `--space-section` grows from 40px to 76px, matching the legacy section padding.
- **Radii:**
  - `--radius-sm` 12: inputs and thumbnails
  - `--radius-md` 18: countdown tiles
  - `--radius-lg` 24: **cards (legacy)**
  - `--radius-xl` 30: feature panels
  - `--radius-sheet` 28: the top of a bottom sheet
  - `--radius-pill`: buttons and tags
- **Shadows:** tinted with ink, never neutral grey. `--shadow-md` is the legacy `0 12px 35px rgba(19,55,49,.12)`.
- **Z-index:**
  - `--z-sticky` 100: TopNav
  - `--z-nav` 200: BottomNav
  - `--z-banner` 300: offline/update banner
  - `--z-overlay` 400
  - `--z-toast` 500
  - Dialogs and the lightbox use the native top layer anyway.
- **Motion:**
  - durations: `--duration-fast` 150ms, `--duration-base` 240ms, `--duration-slow` 400ms
  - easings: `--ease-out` and `--ease-spring`
  - under `prefers-reduced-motion: reduce`, every duration becomes 0 and `base.css` neutralises animations.
- **Sizing:**
  - `--tap-min` 44px
  - `--control-height` 48px
  - `--bottom-nav-height` 64px
  - `--top-nav-height` 72px
- **Safe areas:** `--safe-top/right/bottom/left` wrap `env(safe-area-inset-*)`. The viewport meta must include `viewport-fit=cover`; see the WP-0.6 note in `WP-0.7.md`.

### Breakpoints (min-width only)

| Name | Min width | What changes |
|---|---|---|
| base | 0 | single column, BottomNav, bottom-sheet dialogs |
| `sm` | 600px | dialogs centre, 2-column card grids, toasts dock right |
| `md` | 900px | TopNav links appear, **BottomNav hides**, 3-column grids, side-by-side layouts |
| `lg` | 1200px | content reaches `--content-max` (70rem) |

## 3. Base (`shared/styles/base.css`)
- A modern reset, with `box-sizing`, media `max-width: 100%`, and inherited `font` on controls.
- `body` is clipped with `overflow-x: clip` as a backstop. Components are still verified not to overflow at 305px.
- Inputs use `font-size: max(16px, 1em)`.
- `:focus-visible` draws a 3px dark outline with a 3px gold halo. `:focus` without `-visible` draws no ring.
- Utilities:
  - `.visually-hidden`
  - `.cu-container`: a centred column with safe-area-aware gutters
  - `.cu-kicker`
  - `.cu-hero-surface`: the legacy gradient
  - `.cu-papel-picado`
  - `.cu-skip-link`

## 4. Components (`shared/ui`, import from `shared/ui` barrel)

| Component | Notes |
|---|---|
| `Button` | Variants:<br>• `primary`: gold, the legacy CTA<br>• `secondary`: white with a green border<br>• `ghost`<br>• `whatsapp`<br>• `danger`<br><br>Sizes: `sm` 44, `md` 48, `lg` 56.<br><br>Use `surface="dark"` on the hero. Use `to` for a router Link, `href` (+ `external`) for an anchor, and neither for a `<button type="button">`. `loading` shows a spinner, sets `aria-busy` and disables the button. `fullWidth` is for the main mobile action. Labels wrap; they never truncate. |
| `IconButton` | Its `label` (the accessible name) is required. 44px or 56px. Variants: `soft`, `plain`, `solid`, `inverse`. |
| `Card` | `tone`:<br>• `default`<br>• `brand`: the green gradient panel<br>• `accent`: tips<br>• `sunken`<br><br>Optional emoji `icon` and `title` (h3). `as="article"` is for programa days. |
| `Field` | Render prop `{(p) => <TextInput {...p}/>}`. Wires `htmlFor`, `aria-describedby` (hint then error), `aria-invalid` and `required`. Optional fields show "(opcional)". There are no asterisks. Phase-1 forms set `noValidate` on `<form>` so our Spanish errors replace the browser's locale bubbles. |
| `TextInput`, `TextArea`, `Select` | Share `controls.module.css`. Text is 16px, height 48px. `Select` is native, so it gets the OS picker. **Always** set `type`, `inputMode` and `autoComplete`. |
| `Checkbox`, `Switch` | Native checkbox; `Switch` adds `role="switch"`. The whole row is the tap target. Takes `hint` and `error`. |
| `Dialog` | Native `<dialog>` + `showModal()`.<br>• Under 600px it's a **bottom sheet** with a grabber (visual only) and a sticky footer in the thumb zone; the primary action sits on top.<br>• At 600px and up it's a centred card.<br><br>It traps focus, closes on Esc and backdrop tap, restores focus and locks scroll. Use `role="alertdialog"` + `closeOnBackdrop={false}` for destructive confirmations. |
| `BottomNav` | Five tabs: Inicio, Programa, Fotos, Chat, Más. Fixed, blurred, and pads for the safe area. The active tab gets a gold-soft pill and `aria-current="page"`. Count/dot badges use bugambilia, with `badgeLabel` for screen readers. Hidden at 900px and up. It's router-agnostic through `renderLink`: use `renderRouterLink` from the barrel with `currentPath={useLocation().pathname}`. |
| `TopNav` | Sticky cream bar with the brand and `actions`. Below 900px it's a brand-only app bar; at 900px and up the links appear inline. `surface="hero"` makes it transparent over the hero. |
| `PageShell` | Skip link "Saltar al contenido", header, banner slot (offline/update), `<main id="contenido">`, footer and bottom nav. Reserves `64px + safe-bottom` under the content on mobile. `layout="bleed"` is for pages that start with a hero. |
| `AvatarCircle` | Photo with an initials fallback. Particles are skipped, so "María de la Luz Cuenca" becomes "MC". The tint is chosen by a stable hash and every tint passes 4.5:1. Sizes: 32, 48, 64 (the legacy attendee circle), 96. `highlight` adds a gold ring. |
| `AvatarStack` | `overlap` or `grid` layout, with a "+N" chip. `total` covers paginated lists. The accessible label is "48 asistentes". |
| `Toast` | `ToastProvider` + `useToast().show({ message, tone, action, duration })`.<br>• info/success use a polite `role="status"`; danger uses `role="alert"`.<br>• Toasts sit above the BottomNav and dock bottom-right at 900px and up.<br>• At most three are shown.<br>• Toasts with an `action` stay until dismissed; an explicit duration is raised to at least 10s.<br>• All timers pause while the toast is hovered or focused (WCAG 2.2.1). |
| `Spinner`, `Skeleton` | Spinner: `role="status"` with "Cargando…". Skeleton: `aria-hidden`, and its shimmer stops under reduced motion. |
| `EmptyState` | Emoji in a gradient disc, title, description and action. `tone="lock"` is the members-only state. |
| `Tabs` | WAI-ARIA tabs with roving tabindex and ←/→/Home/End. `pill` (segmented) or `underline`. The list scrolls sideways on phones; it doesn't wrap. |
| `Badge` | `pill`: tags such as "🚌 Transporte incluido". `count`: shows 99+. `dot`. Tones: neutral, brand, accent, festive, success, danger. |
| `Countdown` | Pure: pass `target`, `now` and `end`. Three phases:<br>• upcoming: días/horas/minutos/segundos tiles<br>• live: "🎉 ¡YA LLEGÓ LA CUENCADA! 🎉"<br>• past: a thank-you message<br><br>`role="timer"` with a spoken summary; it's never a live region. `getCountdown()` is exported for logic. |
| `Lightbox` | Full-screen native dialog. Swipe with pointer events (50px threshold, horizontal-dominant), ←/→, and Esc. Images and `<video controls playsInline>`. Shows a "3 de 12" counter, ‹ › buttons of 56px in the thumb zone, a caption, and an `actions` slot for download or report. It doesn't wrap around.<br>• Gestures and arrow keys that start on a video go to the player (seek, volume), never to navigation.<br>• When a focused ‹ › becomes disabled, focus moves to the other control.<br>• It is `aria-modal` and closes itself if the open item disappears. |

## 5. Mobile-first rules (the Tech Lead checks these)
1. Write base styles for phones. Use `@media (min-width: …)` only; **never `max-width`**.
2. Every interactive element is at least 44×44px. Use `IconButton` and never a bare emoji `<button>`.
3. Inputs use 16px text and the right `type`, `inputMode` and `autoComplete`:
   - email: `type="email" inputMode="email" autoComplete="email"`
   - phone: `type="tel" autoComplete="tel"`
   - one-time code: `inputMode="numeric" autoComplete="one-time-code"`
   - new password: `autoComplete="new-password"`
4. Put the primary action in the thumb zone. Use a full-width button at the end of forms and the sticky footer inside sheets.
5. Fixed bars add `--safe-bottom` / `--safe-top`. Content clears the BottomNav. Use `PageShell`.
6. There is no horizontal scroll at 320px. Long content (tab lists, tables) scrolls **inside** its own container.
7. Images use `loading="lazy"`, explicit `width`/`height` or `aspect-ratio`, and WebP thumbnails. Only the hero image is eager.
8. Motion responds to the user (open, confirm) or marks one moment (the "¡YA LLEGÓ!" pop). Nothing loops except spinners, and those stop under reduced motion.
9. Attach screenshots at 375px and 1280px to every UI PR.

## 6. Do / Don't

| Do | Don't |
|---|---|
| Use gold for the single most important action on a screen | Put two gold buttons side by side; make the second `secondary` |
| Use `--color-text-muted` for meta text | Use gold or light grey as text on cream (fails contrast) |
| Use ink text on WhatsApp green | Use white text on `#25D366` |
| Use emoji as decorative `aria-hidden` icons next to words | Use an emoji as the only label of a control |
| Use one papel picado edge per page | Scallop every card |
| Explain locks: "Inicia sesión para ver las fotos…" | Silently hide members-only sections |
| Use native `<select>`, `<dialog>` and checkbox | Build custom pickers that fight the mobile OS |
| Keep the legacy wording where it exists | Translate into corporate copy ("Gestionar contenido multimedia") |

> **Email exceptions** (`packages/emails`, approved in WP-0.5.1): the email call to action is **white on green (`#0b5e55`, 7.65:1) with a 2px gold border**, not ink on gold. Dark-mode inverters (Gmail, Chromium auto-dark) lighten dark text but keep saturated backgrounds, so ink on gold became unreadable.

## 7. Microcopy conventions
- Use tú, sentence case, and active verbs that match the outcome. If the button says "Confirmar asistencia", the toast says "¡Listo! Confirmaste tu asistencia."
- **Errors** say what happened and how to fix it: "No pudimos subir la foto. Revisa tu conexión e inténtalo otra vez." Don't use "¡Ups!" and don't apologise.
- **Dates** use `es-MX` in the Cuencada's timezone: "Lunes 14 de septiembre · 7:40 AM".
- **Money:** "$1,000 p/p".
- See `wireframes.md` for per-screen copy.
