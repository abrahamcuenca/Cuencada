#!/usr/bin/env bash
# Generates the Cuencada PWA icons and migrates legacy brand assets (WP-0.7).
#
#   scripts/generate-icons.sh
#
# Outputs (apps/web/public/):
#   icons/favicon.svg                 vector favicon (rounded tile)
#   icons/icon-192.png, icon-512.png  manifest "any" icons (rounded tile, transparent corners)
#   icons/maskable-192.png, maskable-512.png  manifest "maskable" icons (full-bleed, art in 80% safe zone)
#   icons/apple-touch-icon.png        180x180, opaque, full-bleed (iOS rounds it)
#   images/Bandera_Mexico.webp        legacy images/Bandera_México.png is really WebP; re-encoded at 240px wide (shown at ~30px) with an ASCII name
#   images/logo-96.webp               96px logo for headers (the 640px JPEG is too heavy for a 40px slot)
#
# Requires ImageMagick (`magick` v7 or `convert` v6) with the WebP delegate.
# Uses `rsvg-convert` for SVG rasterisation when available (best quality).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC="$ROOT/apps/web/public"
ICONS="$PUBLIC/icons"
IMAGES="$PUBLIC/images"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$ICONS" "$IMAGES"

if command -v magick >/dev/null 2>&1; then
  IM=(magick)
elif command -v convert >/dev/null 2>&1; then
  IM=(convert)
else
  echo "ImageMagick no está instalado (se necesita magick o convert)." >&2
  exit 1
fi

# Brand art: a gold "C" monogram opening toward a rising sun, on the legacy
# green hero gradient. Shapes only (no text) so every renderer draws it the same.
# $1 = background shape: "tile" (rounded, transparent corners) or "bleed" (full square)
brand_svg() {
  local bg
  if [[ "$1" == "tile" ]]; then
    bg='<rect width="512" height="512" rx="112" fill="url(#g)"/><rect width="512" height="512" rx="112" fill="url(#glow)"/>'
  else
    bg='<rect width="512" height="512" fill="url(#g)"/><rect width="512" height="512" fill="url(#glow)"/>'
  fi
  cat <<SVG
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a3f39"/>
      <stop offset="1" stop-color="#087f6d"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.82" cy="0.16" r="0.45">
      <stop offset="0" stop-color="#e7b84b" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#e7b84b" stop-opacity="0"/>
    </radialGradient>
  </defs>
  ${bg}
  <path d="M346 148.8 A140 140 0 1 0 346 363.2" fill="none" stroke="#e7b84b" stroke-width="64" stroke-linecap="round"/>
  <circle cx="350" cy="256" r="30" fill="#ffe39a"/>
</svg>
SVG
}

brand_svg tile >"$ICONS/favicon.svg"
brand_svg tile >"$WORK/tile.svg"
brand_svg bleed >"$WORK/bleed.svg"

# Rasterise an SVG at a given size.
raster() {
  local src="$1" size="$2" out="$3"
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$size" -h "$size" "$src" -o "$out"
  else
    # Render big then downsample for clean anti-aliasing with ImageMagick's SVG renderer.
    "${IM[@]}" -background none -density 384 "$src" -resize "${size}x${size}" "PNG32:$out"
  fi
}

raster "$WORK/tile.svg" 192 "$ICONS/icon-192.png"
raster "$WORK/tile.svg" 512 "$ICONS/icon-512.png"
raster "$WORK/bleed.svg" 192 "$ICONS/maskable-192.png"
raster "$WORK/bleed.svg" 512 "$ICONS/maskable-512.png"
raster "$WORK/bleed.svg" 180 "$WORK/apple.png"
# Apple touch icons must be opaque.
"${IM[@]}" "$WORK/apple.png" -background "#0a3f39" -alpha remove -alpha off "PNG24:$ICONS/apple-touch-icon.png"

# Legacy asset migration ------------------------------------------------------
LEGACY_FLAG="$ROOT/images/Bandera_México.png"
if [[ -f "$LEGACY_FLAG" ]]; then
  # The legacy file is WebP despite its .png name; decode explicitly as WebP.
  "${IM[@]}" "webp:$LEGACY_FLAG" -strip -resize "240x>" -quality 85 "$IMAGES/Bandera_Mexico.webp"
fi

LEGACY_LOGO="$ROOT/images/Logo_Cuencada2026.jpg"
if [[ -f "$LEGACY_LOGO" ]]; then
  "${IM[@]}" "$LEGACY_LOGO" -strip -resize 96x96 -quality 82 "$IMAGES/logo-96.webp"
fi

echo "Iconos generados en $ICONS"
ls -l "$ICONS" "$IMAGES"/*.webp
