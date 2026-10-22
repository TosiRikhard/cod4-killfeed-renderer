/**
 * CoD4 .iwi texture decoding (version 6): a 28-byte header, then the mip levels
 * stored smallest first, so the full-size image is the last block of the file.
 *
 *   0  "IWi" + version byte (6)
 *   4  format: 1 ARGB32, 2 RGB24, 3 GA16, 4 A8, 11 DXT1, 12 DXT3, 13 DXT5
 *   5  usage flags
 *   6  u16 width, u16 height, u16 depth
 *   12 4 x i32 mip offsets
 */
export interface IwiImage {
  width: number;
  height: number;
  format: number;
  /** Decoded pixels, RGBA8, row-major. */
  rgba: Uint8Array;
}

const FORMAT_BYTES_PER_PIXEL: Record<number, number> = { 1: 4, 2: 3, 3: 2, 4: 1, 11: 0.5, 12: 1, 13: 1 };

export function decodeIwi(buf: Uint8Array): IwiImage {
  if (buf[0] !== 0x49 || buf[1] !== 0x57 || buf[2] !== 0x69) throw new Error("Not an IWI file.");
  if (buf[3] !== 6) throw new Error(`Unsupported IWI version ${buf[3]}.`);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const format = buf[4];
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  const bpp = FORMAT_BYTES_PER_PIXEL[format];
  if (!bpp) throw new Error(`Unsupported IWI format ${format}.`);
  const isDxt = format >= 11;
  const size = isDxt ? Math.max(1, width >> 2) * Math.max(1, height >> 2) * (format === 11 ? 8 : 16) : width * height * bpp;
  if (size > buf.length - 28) throw new Error("IWI file is truncated.");
  const data = buf.subarray(buf.length - size);
  const rgba = new Uint8Array(width * height * 4);
  if (isDxt) decodeDxt(data, width, height, format, rgba);
  else {
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      if (format === 1) {
        // Stored as BGRA.
        rgba[o] = data[i * 4 + 2];
        rgba[o + 1] = data[i * 4 + 1];
        rgba[o + 2] = data[i * 4];
        rgba[o + 3] = data[i * 4 + 3];
      } else if (format === 2) {
        rgba[o] = data[i * 3 + 2];
        rgba[o + 1] = data[i * 3 + 1];
        rgba[o + 2] = data[i * 3];
        rgba[o + 3] = 255;
      } else if (format === 3) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = data[i * 2];
        rgba[o + 3] = data[i * 2 + 1];
      } else {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = 255;
        rgba[o + 3] = data[i];
      }
    }
  }
  return { width, height, format, rgba };
}

function decodeDxt(data: Uint8Array, width: number, height: number, format: number, out: Uint8Array): void {
  const blockBytes = format === 11 ? 8 : 16;
  const bw = Math.max(1, width >> 2);
  const bh = Math.max(1, height >> 2);
  const colors = new Uint8Array(16);
  const alpha = new Uint8Array(16);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const b = (by * bw + bx) * blockBytes;
      const c = format === 11 ? b : b + 8;
      // Alpha.
      if (format === 11) alpha.fill(255);
      else if (format === 12) {
        for (let i = 0; i < 16; i++) alpha[i] = ((data[b + (i >> 1)] >> ((i & 1) * 4)) & 15) * 17;
      } else {
        const a0 = data[b];
        const a1 = data[b + 1];
        const table = [a0, a1, 0, 0, 0, 0, 0, 0];
        if (a0 > a1) for (let i = 1; i < 7; i++) table[i + 1] = Math.round(((7 - i) * a0 + i * a1) / 7);
        else {
          for (let i = 1; i < 5; i++) table[i + 1] = Math.round(((5 - i) * a0 + i * a1) / 5);
          table[6] = 0;
          table[7] = 255;
        }
        // 48 bits of 3-bit indices, little-endian.
        let bits = 0;
        for (let i = 0; i < 6; i++) bits += data[b + 2 + i] * 2 ** (8 * i);
        for (let i = 0; i < 16; i++) alpha[i] = table[Math.floor(bits / 2 ** (3 * i)) & 7];
      }
      // Colour.
      const c0 = data[c] | (data[c + 1] << 8);
      const c1 = data[c + 2] | (data[c + 3] << 8);
      const rgb = (v: number) => [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31];
      const p0 = rgb(c0);
      const p1 = rgb(c1);
      const palette = [p0, p1, [0, 0, 0], [0, 0, 0]];
      const fourColor = format !== 11 || c0 > c1;
      let transparentIndex = -1;
      for (let k = 0; k < 3; k++) {
        if (fourColor) {
          palette[2][k] = (2 * p0[k] + p1[k]) / 3;
          palette[3][k] = (p0[k] + 2 * p1[k]) / 3;
        } else {
          palette[2][k] = (p0[k] + p1[k]) / 2;
          transparentIndex = 3;
        }
      }
      const idx = data[c + 4] | (data[c + 5] << 8) | (data[c + 6] << 16) | (data[c + 7] * 2 ** 24);
      for (let i = 0; i < 16; i++) colors[i] = Math.floor(idx / 2 ** (2 * i)) & 3;
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x >= width || y >= height) continue;
          const i = py * 4 + px;
          const o = (y * width + x) * 4;
          const p = palette[colors[i]];
          out[o] = Math.round(p[0]);
          out[o + 1] = Math.round(p[1]);
          out[o + 2] = Math.round(p[2]);
          out[o + 3] = colors[i] === transparentIndex ? 0 : alpha[i];
        }
      }
    }
  }
}
