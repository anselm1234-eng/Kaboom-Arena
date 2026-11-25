/**
 * Generates all Blastmates brand assets into /brand and copies the web
 * assets into packages/client/public. Run from the repo root:
 *
 *   node brand/generate.mjs
 *
 * The wordmark uses Baloo 2 (OFL) converted to outlines; the bomb mark is
 * an original drawing (round navy bomb, short fuse, 4-point spark).
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';
import pngToIco from 'png-to-ico';
import sharp from 'sharp';

const BRAND_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(BRAND_DIR, '../packages/client/public');

const ORANGE = '#FF6B2C';
const NAVY = '#1B2440';
const YELLOW = '#FFD23F';
const LIGHT = '#F4F1EA';

// --- Wordmark: "Blastmates" as outlined paths (Baloo 2, fattened) ---

const fontBytes = readFileSync(path.join(BRAND_DIR, 'Baloo2-ExtraBold.ttf'));
const font = opentype.parse(
  fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength),
);
const FONT_SIZE = 160;
const text = 'Blastmates';
const otPath = font.getPath(text, 0, 0, FONT_SIZE, { kerning: true });
const bbox = otPath.getBoundingBox();
const pathData = otPath.toPathData(2);
const wmW = bbox.x2 - bbox.x1;
const wmH = bbox.y2 - bbox.y1;
// Stroke thickens the Regular master into a chunky, rounded weight.
const STROKE = 9;

/** Wordmark path element, fill+stroke in one color, normalized to x/y 0. */
function wordmarkPath(fill) {
  return (
    `<g transform="translate(${(-bbox.x1 + STROKE / 2).toFixed(2)} ${(-bbox.y1 + STROKE / 2).toFixed(2)})">` +
    `<path d="${pathData}" fill="${fill}" stroke="${fill}" stroke-width="${STROKE}" ` +
    `stroke-linejoin="round" stroke-linecap="round" paint-order="stroke fill"/></g>`
  );
}

const WM_W = Math.ceil(wmW + STROKE);
const WM_H = Math.ceil(wmH + STROKE);

/**
 * Original bomb mark, drawn in a 100x100 viewBox: a round navy bomb with a
 * flat highlight, short rope fuse, and a 4-point yellow spark. No face, no
 * character features — just a friendly object.
 */
function bombMark({ body = NAVY, spark = YELLOW, fuse = ORANGE, shine = LIGHT } = {}) {
  return `
  <g>
    <!-- 4-point spark -->
    <path d="M78 8 L82.5 19.5 L94 24 L82.5 28.5 L78 40 L73.5 28.5 L62 24 L73.5 19.5 Z" fill="${spark}"/>
    <!-- short fuse -->
    <path d="M62 36 Q70 28 76 25" fill="none" stroke="${fuse}" stroke-width="9" stroke-linecap="round"/>
    <!-- bomb cap -->
    <rect x="50" y="32" width="22" height="14" rx="6" fill="${body}" transform="rotate(-40 61 39)"/>
    <!-- body -->
    <circle cx="44" cy="62" r="34" fill="${body}"/>
    <!-- highlight -->
    <circle cx="32" cy="51" r="9" fill="${shine}" opacity="0.92"/>
  </g>`;
}

function svgDoc(w, h, content, bg = null) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    (bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : '') +
    content +
    '</svg>'
  );
}

// logo-mark.svg: just the bomb (canonical: navy body, for light backgrounds).
const logoMark = svgDoc(100, 100, bombMark());
// Variant for dark/navy backgrounds: orange body, light shine and fuse.
const bombOnDark = () => bombMark({ body: ORANGE, shine: LIGHT, fuse: LIGHT });

// wordmark.svg: text only (navy, for light backgrounds).
const wordmark = svgDoc(WM_W, WM_H, wordmarkPath(NAVY));

// logo-horizontal.svg: mark + wordmark, light text for navy backgrounds.
const HM_SCALE = (WM_H / 100) * 1.35;
const H_GAP = 18;
const H_W = Math.ceil(100 * HM_SCALE + H_GAP + WM_W);
const H_H = Math.ceil(Math.max(100 * HM_SCALE, WM_H));
const logoHorizontal = svgDoc(
  H_W,
  H_H,
  `<g transform="translate(0 ${(H_H - 100 * HM_SCALE) / 2}) scale(${HM_SCALE})">${bombMark()}</g>` +
    `<g transform="translate(${100 * HM_SCALE + H_GAP} ${(H_H - WM_H) / 2})">${wordmarkPath(NAVY)}</g>`,
);
const logoHorizontalLight = svgDoc(
  H_W,
  H_H,
  `<g transform="translate(0 ${(H_H - 100 * HM_SCALE) / 2}) scale(${HM_SCALE})">${bombOnDark()}</g>` +
    `<g transform="translate(${100 * HM_SCALE + H_GAP} ${(H_H - WM_H) / 2})">${wordmarkPath(LIGHT)}</g>`,
);

// logo-stacked.svg: mark above wordmark.
const ST_SCALE = 2.0;
const ST_W = Math.max(100 * ST_SCALE, WM_W);
const ST_H = 100 * ST_SCALE + 24 + WM_H;
const logoStacked = svgDoc(
  Math.ceil(ST_W),
  Math.ceil(ST_H),
  `<g transform="translate(${(ST_W - 100 * ST_SCALE) / 2} 0) scale(${ST_SCALE})">${bombOnDark()}</g>` +
    `<g transform="translate(${(ST_W - WM_W) / 2} ${100 * ST_SCALE + 24})">${wordmarkPath(LIGHT)}</g>`,
);

// favicon.svg: bold simplified mark on navy tile, tuned for 16px.
const favicon = svgDoc(
  100,
  100,
  `<rect width="100" height="100" rx="22" fill="${NAVY}"/>
   <path d="M76 4 L82 18 L96 24 L82 30 L76 44 L70 30 L56 24 L70 18 Z" fill="${YELLOW}"/>
   <path d="M56 40 Q66 30 73 27" fill="none" stroke="${ORANGE}" stroke-width="11" stroke-linecap="round"/>
   <circle cx="42" cy="64" r="33" fill="${LIGHT}"/>
   <circle cx="42" cy="64" r="26" fill="${ORANGE}"/>
   <circle cx="33" cy="55" r="7" fill="${LIGHT}"/>`,
);

// og-image: 1200x630 navy with subtle grid + stacked logo + tagline.
function ogImage() {
  let grid = '';
  for (let x = 0; x <= 1200; x += 60) {
    grid += `<line x1="${x}" y1="0" x2="${x}" y2="630" stroke="${LIGHT}" stroke-opacity="0.05" stroke-width="2"/>`;
  }
  for (let y = 0; y <= 630; y += 60) {
    grid += `<line x1="0" y1="${y}" x2="1200" y2="${y}" stroke="${LIGHT}" stroke-opacity="0.05" stroke-width="2"/>`;
  }
  // Fit mark + wordmark into 1000px of usable width.
  const markScale = 2.0;
  const gap = 28;
  const scale = (1000 - 100 * markScale - gap) / WM_W;
  const logoW = 100 * markScale + gap + WM_W * scale;
  const x0 = (1200 - logoW) / 2;
  const logoTop = 180;
  return svgDoc(
    1200,
    630,
    grid +
      `<g transform="translate(${x0} ${logoTop}) scale(${markScale})">${bombOnDark()}</g>` +
      `<g transform="translate(${x0 + 100 * markScale + gap} ${logoTop + (100 * markScale - WM_H * scale) / 2}) scale(${scale})">${wordmarkPath(LIGHT)}</g>` +
      `<text x="600" y="500" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="bold" fill="${YELLOW}">Blow up your buddies.</text>`,
    NAVY,
  );
}

async function main() {
  mkdirSync(PUBLIC_DIR, { recursive: true });

  const svgs = {
    'logo-mark.svg': logoMark,
    'wordmark.svg': wordmark,
    'logo-horizontal.svg': logoHorizontal,
    'logo-horizontal-light.svg': logoHorizontalLight,
    'logo-stacked.svg': logoStacked,
    'favicon.svg': favicon,
  };
  for (const [name, content] of Object.entries(svgs)) {
    writeFileSync(path.join(BRAND_DIR, name), content);
  }

  // PNG renders.
  const faviconBuf = Buffer.from(favicon);
  await sharp(faviconBuf).resize(192, 192).png().toFile(path.join(BRAND_DIR, 'icon-192.png'));
  await sharp(faviconBuf).resize(512, 512).png().toFile(path.join(BRAND_DIR, 'icon-512.png'));
  await sharp(faviconBuf).resize(180, 180).png().toFile(path.join(BRAND_DIR, 'apple-touch-icon.png'));
  await sharp(Buffer.from(ogImage()), { density: 96 })
    .resize(1200, 630)
    .png()
    .toFile(path.join(BRAND_DIR, 'og-image.png'));

  // favicon.ico from 16/32/48 renders.
  const icoSizes = await Promise.all(
    [16, 32, 48].map((s) => sharp(faviconBuf).resize(s, s).png().toBuffer()),
  );
  writeFileSync(path.join(BRAND_DIR, 'favicon.ico'), await pngToIco(icoSizes));

  // Wire into the app.
  for (const name of [
    'favicon.svg',
    'favicon.ico',
    'icon-192.png',
    'icon-512.png',
    'apple-touch-icon.png',
    'og-image.png',
  ]) {
    copyFileSync(path.join(BRAND_DIR, name), path.join(PUBLIC_DIR, name));
  }
  console.log('brand assets generated and copied to packages/client/public');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
