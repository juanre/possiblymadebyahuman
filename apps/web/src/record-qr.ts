import qrcode from "qrcode-generator";

/** Modules of light margin around the code, as the QR specification requires. */
const QUIET_ZONE = 4;

export type RecordQrCode = {
  /** Width and height in modules, quiet zone included. */
  size: number;
  isDark(row: number, col: number): boolean;
  /** SVG path of the dark modules, one unit per module. */
  path: string;
};

// Error correction level M survives a smudged or slightly damaged print while
// keeping the code small for a record address.
export function recordQrCode(url: string): RecordQrCode {
  const qr = qrcode(0, "M");
  qr.addData(url, "Byte");
  qr.make();
  const count = qr.getModuleCount();
  const size = count + QUIET_ZONE * 2;
  const isDark = (row: number, col: number) => {
    const r = row - QUIET_ZONE, c = col - QUIET_ZONE;
    return r >= 0 && c >= 0 && r < count && c < count && qr.isDark(r, c);
  };
  // Each horizontal run of dark modules is one rectangle.
  const runs: string[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!isDark(row, col)) continue;
      const start = col;
      while (col + 1 < size && isDark(row, col + 1)) col++;
      const width = col - start + 1;
      runs.push(`M${start} ${row}h${width}v1h-${width}z`);
    }
  }
  return { size, isDark, path: runs.join("") };
}

/** A standalone SVG file of the code, black on white, for printing. */
export function recordQrSvg(url: string): string {
  const code = recordQrCode(url);
  const title = url.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${code.size} ${code.size}" width="${code.size * 8}" height="${code.size * 8}" shape-rendering="crispEdges">`
    + `<title>${title}</title><rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${code.path}"/></svg>\n`;
}
