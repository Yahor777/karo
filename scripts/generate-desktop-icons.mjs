// Placeholder icon generator for the Windows Desktop App
// (`apps/desktop-windows/src-tauri/icons/*`).
//
// Tauri 2's `tauri-build` step requires real `.ico` / `.png` assets at
// the paths declared in `bundle.icon` of `tauri.conf.json`. To keep the
// project self-bootstrapping (no Photoshop/Inkscape dependency, no
// committed binary blobs from a third-party tool), this script renders
// a minimal "K" glyph onto a coloured square and emits:
//
//   • icons/32x32.png
//   • icons/128x128.png
//   • icons/128x128@2x.png  (256×256)
//   • icons/icon.png        (512×512, the "source" for tauri icon CLI)
//   • icons/icon.ico        (multi-resolution: 16, 32, 48, 64, 256)
//
// Implementation notes:
//
//   * PNG is hand-rolled via the `zlib` module so we don't need a
//     third-party dependency. Format: type-6 RGBA, bit depth 8, no
//     interlacing.
//   * ICO embeds PNG-encoded images per icon directory entry. The
//     PNG-in-ICO format has been supported since Windows Vista and
//     `tauri-build` accepts it.
//   * The K glyph is drawn pixel-by-pixel using a tiny vector
//     description (vertical bar + two diagonals). It's intentionally
//     simple — replace with a real branded icon later.
//
// Re-run: `node scripts/generate-desktop-icons.mjs`

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ICON_DIR = join(
  __dirname,
  "..",
  "apps",
  "desktop-windows",
  "src-tauri",
  "icons",
);

// --------------------------------------------------------------------------
// Drawing
// --------------------------------------------------------------------------

const BACKGROUND = [0x1f, 0x6f, 0xeb, 0xff]; // GitHub blue, opaque
const FOREGROUND = [0xff, 0xff, 0xff, 0xff]; // White
const CORNER_RADIUS_FACTOR = 0.18; // 18% of side length

/**
 * Returns true when (x,y) is inside a rounded square of side `size`.
 */
function insideRoundedSquare(x, y, size) {
  const r = size * CORNER_RADIUS_FACTOR;
  if (x < r && y < r) return (r - x) ** 2 + (r - y) ** 2 <= r * r;
  if (x >= size - r && y < r)
    return (x - (size - r)) ** 2 + (r - y) ** 2 <= r * r;
  if (x < r && y >= size - r)
    return (r - x) ** 2 + (y - (size - r)) ** 2 <= r * r;
  if (x >= size - r && y >= size - r)
    return (x - (size - r)) ** 2 + (y - (size - r)) ** 2 <= r * r;
  return true;
}

/**
 * Draws a stylised letter K. Returns true when (x,y) is part of the
 * glyph stroke. Geometry is parametrised by `size`.
 */
function insideK(x, y, size) {
  const padding = size * 0.18;
  const stroke = Math.max(1, Math.round(size * 0.14));
  const left = padding;
  const right = size - padding;
  const top = padding;
  const bottom = size - padding;
  const midX = left + (right - left) * 0.42;
  const midY = top + (bottom - top) * 0.5;

  // Vertical bar — left edge of the K.
  if (x >= left && x < left + stroke && y >= top && y <= bottom) {
    return true;
  }

  // Upper diagonal (midX → top-right).
  if (
    x >= midX &&
    x <= right &&
    y >= top &&
    y <= midY &&
    Math.abs((y - midY) / (top - midY) - (x - midX) / (right - midX)) <
      stroke / size
  ) {
    return true;
  }

  // Lower diagonal (midX → bottom-right).
  if (
    x >= midX &&
    x <= right &&
    y >= midY &&
    y <= bottom &&
    Math.abs((y - midY) / (bottom - midY) - (x - midX) / (right - midX)) <
      stroke / size
  ) {
    return true;
  }

  return false;
}

/**
 * Renders an RGBA buffer of `size`×`size` pixels containing the K
 * glyph on the rounded background. Each pixel is 4 bytes (R,G,B,A).
 */
function renderRgba(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (y * size + x) * 4;
      const inSquare = insideRoundedSquare(x, y, size);
      if (!inSquare) {
        // Outside rounded square → fully transparent.
        pixels[idx + 0] = 0;
        pixels[idx + 1] = 0;
        pixels[idx + 2] = 0;
        pixels[idx + 3] = 0;
        continue;
      }
      const onGlyph = insideK(x, y, size);
      const colour = onGlyph ? FOREGROUND : BACKGROUND;
      pixels[idx + 0] = colour[0];
      pixels[idx + 1] = colour[1];
      pixels[idx + 2] = colour[2];
      pixels[idx + 3] = colour[3];
    }
  }
  return pixels;
}

// --------------------------------------------------------------------------
// PNG encoding
// --------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcVal = crc32(crcInput);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/**
 * Encodes an RGBA buffer as a PNG file.
 */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type = RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // PNG scanlines: filter byte (0 = None) + RGBA row.
  const stride = size * 4;
  const filtered = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y += 1) {
    filtered[y * (stride + 1)] = 0; // filter type: None
    rgba.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(filtered, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --------------------------------------------------------------------------
// ICO encoding (PNG-embedded)
// --------------------------------------------------------------------------

function encodeIco(pngs) {
  // ICONDIR: 6 bytes — reserved=0, type=1, count=N.
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(pngs.length, 4);

  // Each ICONDIRENTRY is 16 bytes.
  const entries = Buffer.alloc(16 * pngs.length);
  let dataOffset = 6 + 16 * pngs.length;
  pngs.forEach(({ size, png }, idx) => {
    const entry = entries.subarray(idx * 16, (idx + 1) * 16);
    // width / height: 0 means 256+
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // colour count
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8); // bytes in resource
    entry.writeUInt32LE(dataOffset, 12); // image offset
    dataOffset += png.length;
  });

  return Buffer.concat([dir, entries, ...pngs.map((p) => p.png)]);
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

function main() {
  mkdirSync(ICON_DIR, { recursive: true });
  console.log(`[icons] writing into ${ICON_DIR}`);

  const png32 = encodePng(renderRgba(32), 32);
  const png128 = encodePng(renderRgba(128), 128);
  const png256 = encodePng(renderRgba(256), 256);
  const png512 = encodePng(renderRgba(512), 512);

  writeFileSync(join(ICON_DIR, "32x32.png"), png32);
  writeFileSync(join(ICON_DIR, "128x128.png"), png128);
  writeFileSync(join(ICON_DIR, "128x128@2x.png"), png256);
  writeFileSync(join(ICON_DIR, "icon.png"), png512);

  // Multi-resolution ICO. Sizes < 256 are stored at their declared
  // dimensions; 256 is encoded with width=height=0 per the ICO spec.
  const ico = encodeIco([
    { size: 16, png: encodePng(renderRgba(16), 16) },
    { size: 32, png: png32 },
    { size: 48, png: encodePng(renderRgba(48), 48) },
    { size: 64, png: encodePng(renderRgba(64), 64) },
    { size: 256, png: png256 },
  ]);
  writeFileSync(join(ICON_DIR, "icon.ico"), ico);

  console.log("[icons] generated:");
  console.log("        - 32x32.png");
  console.log("        - 128x128.png");
  console.log("        - 128x128@2x.png");
  console.log("        - icon.png  (512×512, source)");
  console.log("        - icon.ico  (16, 32, 48, 64, 256)");
}

main();
