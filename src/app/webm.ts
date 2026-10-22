/**
 * Minimal WebM writer for VP8/VP9 video with an alpha channel. WebM stores alpha as a second
 * VP8/VP9 stream (the alpha plane encoded as luma) in each block's BlockAdditions (BlockAddID 1),
 * with AlphaMode 1 on the track. Browsers cannot encode alpha with WebCodecs, so the page encodes
 * the color and alpha streams separately and this writer pairs them up.
 */

type Bytes = Uint8Array;

function idBytes(id: number): Bytes {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Uint8Array.from(out);
}

function sizeBytes(size: number): Bytes {
  // 8-byte EBML size: 0x01 marker then 7 bytes.
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = size;
  for (let i = 7; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function concat(parts: Bytes[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function el(id: number, ...children: Bytes[]): Bytes {
  const body = concat(children);
  return concat([idBytes(id), sizeBytes(body.length), body]);
}

function uint(id: number, value: number): Bytes {
  const out: number[] = [];
  let v = value;
  do {
    out.unshift(v % 256);
    v = Math.floor(v / 256);
  } while (v > 0);
  return el(id, Uint8Array.from(out));
}

function float(id: number, value: number): Bytes {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value);
  return el(id, b);
}

function str(id: number, value: string): Bytes {
  return el(id, new TextEncoder().encode(value));
}

export interface WebmFrame {
  /** Milliseconds from the start. */
  time: number;
  key: boolean;
  color: Bytes;
  alpha?: Bytes;
}

export class WebmWriter {
  private clusters: Bytes[] = [];
  private cues: { time: number; offset: number }[] = [];
  private clusterFrames: Bytes[] = [];
  private clusterTime = -1;
  private offset = 0;
  private lastTime = 0;

  constructor(
    private width: number,
    private height: number,
    private codec: "V_VP9" | "V_VP8",
    private alpha: boolean,
    private frameMs: number,
  ) {}

  add(f: WebmFrame): void {
    // Start a new cluster at keyframes (and at least every 30 s: block times are 16-bit relative).
    if (this.clusterTime < 0 || (f.key && f.time - this.clusterTime >= 1000) || f.time - this.clusterTime > 30000) this.flushCluster(f.time);
    const rel = Math.round(f.time - this.clusterTime);
    const header = new Uint8Array(4);
    header[0] = 0x81; // track number 1
    header[1] = (rel >> 8) & 0xff;
    header[2] = rel & 0xff;
    header[3] = 0;
    const block = el(0xa1, header, f.color);
    const parts = [block];
    if (this.alpha && f.alpha) parts.push(el(0x75a1, el(0xa6, uint(0xee, 1), el(0xa5, f.alpha))));
    if (!f.key) parts.push(el(0xfb, Uint8Array.from([0xff]))); // ReferenceBlock (-1): marks a non-key frame
    this.clusterFrames.push(el(0xa0, ...parts));
    this.lastTime = f.time;
  }

  private flushCluster(nextTime: number): void {
    if (this.clusterFrames.length) {
      const cluster = el(0x1f43b675, uint(0xe7, Math.round(this.clusterTime)), ...this.clusterFrames);
      this.cues.push({ time: Math.round(this.clusterTime), offset: this.offset });
      this.clusters.push(cluster);
      this.offset += cluster.length;
    }
    this.clusterFrames = [];
    this.clusterTime = nextTime;
  }

  finish(): Blob {
    this.flushCluster(-1);
    const ebml = el(
      0x1a45dfa3,
      uint(0x4286, 1),
      uint(0x42f7, 1),
      uint(0x42f2, 4),
      uint(0x42f3, 8),
      str(0x4282, "webm"),
      uint(0x4287, 4),
      uint(0x4285, 2),
    );
    const info = el(0x1549a966, uint(0x2ad7b1, 1000000), float(0x4489, this.lastTime + this.frameMs), str(0x4d80, "cod4-killfeed"), str(0x5741, "cod4-killfeed"));
    const video = el(0xe0, uint(0xb0, this.width), uint(0xba, this.height), ...(this.alpha ? [uint(0x53c0, 1)] : []));
    const tracks = el(
      0x1654ae6b,
      el(0xae, uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1), str(0x86, this.codec), uint(0x9c, 0), uint(0x23e383, Math.round(this.frameMs * 1e6)), video),
    );
    // Cues point at cluster positions relative to the segment data start: info + tracks + cues come first.
    const cuesFor = (base: number) =>
      el(0x1c53bb6b, ...this.cues.map((c) => el(0xbb, uint(0xb3, c.time), el(0xb7, uint(0xf7, 1), uint(0xf1, base + c.offset)))));
    let cues = cuesFor(0);
    // The cue sizes depend on the offsets they store; iterate until stable.
    for (let i = 0; i < 4; i++) cues = cuesFor(info.length + tracks.length + cues.length);
    const segmentBody = info.length + tracks.length + cues.length + this.offset;
    return new Blob([ebml as BlobPart, idBytes(0x18538067) as BlobPart, sizeBytes(segmentBody) as BlobPart, info as BlobPart, tracks as BlobPart, cues as BlobPart, ...(this.clusters as BlobPart[])], {
      type: "video/webm",
    });
  }
}
