import assert from "node:assert/strict";
import test from "node:test";
import jsQR from "jsqr";
import { recordQrCode, recordQrSvg } from "../apps/web/src/record-qr.ts";

// Paints the code's dark modules black on white, scale pixels per module.
function rasterize(code, scale = 4) {
  const size = code.size * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!code.isDark(Math.floor(y / scale), Math.floor(x / scale))) continue;
      pixels.fill(0, (y * size + x) * 4, (y * size + x) * 4 + 3);
    }
  }
  return { pixels, size };
}

for (const url of [
  "https://possiblymadebyahuman.com/8XgK6YcyLE",
  `https://possiblymadebyahuman.com/b3:${"a1".repeat(32)}`,
]) {
  test(`the QR code decodes to the record address ${url.length > 60 ? "(full hash)" : "(short signature)"}`, () => {
    const code = recordQrCode(url);
    const { pixels, size } = rasterize(code);
    assert.equal(jsQR(pixels, size, size)?.data, url);
  });
}

test("the QR code keeps a quiet zone of four modules on every side", () => {
  const code = recordQrCode("https://possiblymadebyahuman.com/8XgK6YcyLE");
  for (let i = 0; i < code.size; i++) {
    for (const [row, col] of [[i, 0], [i, 3], [0, i], [3, i], [i, code.size - 1], [code.size - 4, i]]) {
      assert.equal(code.isDark(row, col), false, `module ${row},${col} is in the quiet zone`);
    }
  }
});

test("the SVG file draws the same code, black on white, with its address as the title", () => {
  const url = "https://possiblymadebyahuman.com/8XgK6YcyLE";
  const code = recordQrCode(url);
  const svg = recordQrSvg(url);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, new RegExp(`viewBox="0 0 ${code.size} ${code.size}"`));
  assert.match(svg, /<rect width="100%" height="100%" fill="#fff"\/>/);
  assert.match(svg, new RegExp(`<path fill="#000" d="${code.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"/>`));
  assert.match(svg, /<title>https:\/\/possiblymadebyahuman\.com\/8XgK6YcyLE<\/title>/);
});
