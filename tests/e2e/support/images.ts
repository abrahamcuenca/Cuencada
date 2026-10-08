/**
 * Generated test images (the repo is public: abstract shapes only, never a
 * person or anything identifying).
 */
import type { Page } from "@playwright/test";

/**
 * Draw an abstract JPEG in the page: a gradient, coloured circles and a
 * label, so crops and rotations are visible in screenshots.
 *
 * @param page - Any page (its canvas does the drawing).
 * @param label - Text drawn in the top-left corner.
 * @param width - Pixels.
 * @param height - Pixels.
 */
export async function generateJpeg(page: Page, label: string, width = 900, height = 1200): Promise<Buffer> {
  const base64 = await page.evaluate(
    async ({ text, w, h }) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (ctx === null) throw new Error("no 2d context");
      const gradient = ctx.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, "#0b5e55");
      gradient.addColorStop(1, "#e8b84a");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 14; i += 1) {
        ctx.fillStyle = `hsla(${(i * 41) % 360}, 70%, 60%, 0.65)`;
        ctx.beginPath();
        ctx.arc(((i * 97) % w) + 40, ((i * 173) % h) + 40, 50 + (i % 5) * 18, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "#fff8ec";
      ctx.font = "bold 64px sans-serif";
      ctx.fillText(text, 40, 100);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
      if (blob === null) throw new Error("toBlob failed");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
    { text: label, w: width, h: height }
  );
  return Buffer.from(base64, "base64");
}
