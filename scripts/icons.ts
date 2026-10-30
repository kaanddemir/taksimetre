/**
 * Generates the PWA icons in public/icons/ from the meter's own LED geometry.
 * Run: npm run icons (renders with the Playwright Chromium already used for e2e tests).
 *
 * Concept: one slanted red seven-segment "t." cell on the graphite meter face. The lit segments read
 * as a lowercase t (taksimetre) with the decimal point of a fare reading; the unlit segments stay as
 * faint ghosts, exactly as on the meter. No text, rim or effects, so it survives 48 px.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { LED_GEOMETRY } from "../src/ui/led.ts";

const OUT = new URL("../public/icons/", import.meta.url);
const SURFACE = "#121114"; // --surface (dark theme)
const LED = "#ff2a1c"; // --led
const GHOST = "rgba(255, 42, 28, 0.13)"; // a little stronger than --led-ghost so ghosts survive downscaling
const LIT = "defg"; // lowercase t

const { W, H, T, SKEW, SEGMENTS } = LED_GEOMETRY;

/** One LED cell centred in a 512 box, `scale` = cell height as a share of the box. */
function glyph(scale: number): string {
  const cellW = W + 8 + T; // digit plus decimal point
  const shear = H * Math.tan((-SKEW * Math.PI) / 180);
  const k = (512 * scale) / H;
  const x = (512 - (cellW + shear) * k) / 2;
  const y = (512 - H * k) / 2;
  const segs = Object.entries(SEGMENTS)
    .map(([n, pts]) => `<polygon points="${pts}" fill="${LIT.includes(n) ? LED : GHOST}"/>`)
    .join("");
  const dot = `<circle cx="${W + 8}" cy="${H - T / 2}" r="${T / 2 + 0.5}" fill="${LED}"/>`;
  return `<g transform="translate(${x} ${y}) scale(${k}) translate(${shear} 0) skewX(${SKEW})">${segs}${dot}</g>`;
}

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${body}</svg>`;
/** "any": rounded tile, transparent corners (desktop install, favicon). */
const anyIcon = svg(`<rect width="512" height="512" rx="112" fill="${SURFACE}"/>${glyph(0.56)}`);
/** maskable / Apple: full bleed; the glyph stays inside the 80 % safe circle (cell diagonal < 0.8 × 512). */
const fullIcon = (scale: number) => svg(`<rect width="512" height="512" fill="${SURFACE}"/>${glyph(scale)}`);

const targets: { file: string; size: number; svg: string }[] = [
  { file: "icon-192.png", size: 192, svg: anyIcon },
  { file: "icon-512.png", size: 512, svg: anyIcon },
  { file: "maskable-512.png", size: 512, svg: fullIcon(0.46) },
  { file: "maskable-192.png", size: 192, svg: fullIcon(0.46) },
  { file: "apple-touch-icon.png", size: 180, svg: fullIcon(0.52) },
];

mkdirSync(OUT, { recursive: true });
writeFileSync(new URL("icon.svg", OUT), anyIcon + "\n");
const browser = await chromium.launch();
const page = await browser.newPage();
for (const t of targets) {
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${t.svg}`);
  writeFileSync(new URL(t.file, OUT), await page.screenshot({ omitBackground: true }));
}
await browser.close();
console.log(`icons written to ${OUT.pathname}`);
