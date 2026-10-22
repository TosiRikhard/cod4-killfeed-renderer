/**
 * Offline (faster than real time) video export with WebCodecs.
 *
 * - webm: VP9 with a real alpha channel (two encoders, see webm.ts), for overlays.
 * - mp4:  H.264 on a solid background (green screen / black) for editors without alpha support.
 * - png:  PNG sequence in a zip, the safest choice for After Effects / Premiere / Vegas.
 */
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from "mp4-muxer";
import { WebmWriter } from "./webm.ts";
import { ZipWriter } from "./zip.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExportJob {
  kind: "webm" | "mp4" | "png";
  from: number;
  to: number;
  fps: number;
  width: number;
  height: number;
  /** Solid background for mp4. */
  background: string;
  /** Mbit/s. */
  bitrate: number;
  /**
   * Draw the frame at time t (ms) on a cleared, transparent canvas. Returns a key that is equal for
   * identical frames (so work can be reused) and the area that was drawn on, or null when empty.
   */
  draw: (ctx: OffscreenCanvasRenderingContext2D, t: number) => { key: string; rect: Rect | null };
  onProgress: (done: number, total: number) => void;
  signal: AbortSignal;
}

export function frameCount(job: Pick<ExportJob, "from" | "to" | "fps">): number {
  return Math.max(1, Math.floor(((job.to - job.from) / 1000) * job.fps));
}

export async function runExport(job: ExportJob): Promise<Blob> {
  if (job.kind === "png") return exportPng(job);
  if (typeof VideoEncoder === "undefined") throw new Error("This browser has no WebCodecs video encoder (use Chrome, Edge or a recent Firefox).");
  return job.kind === "webm" ? exportWebm(job) : exportMp4(job);
}

const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

async function waitQueue(enc: VideoEncoder, max = 6): Promise<void> {
  while (enc.encodeQueueSize > max) await new Promise<void>((r) => setTimeout(r, 1));
}

async function pickCodec(candidates: string[], cfg: Omit<VideoEncoderConfig, "codec">): Promise<string> {
  for (const codec of candidates) {
    try {
      if ((await VideoEncoder.isConfigSupported({ ...cfg, codec })).supported) return codec;
    } catch {
      // try the next one
    }
  }
  throw new Error(`No supported encoder among ${candidates.join(", ")} at ${cfg.width}x${cfg.height}.`);
}

function makeContext(job: ExportJob): OffscreenCanvasRenderingContext2D {
  const canvas = new OffscreenCanvas(job.width, job.height);
  return canvas.getContext("2d", { willReadFrequently: job.kind === "webm" })!;
}

/** Grow a rect to even coordinates (4:2:0 chroma covers 2x2 pixels) and clip it to the frame. */
function evenRect(r: Rect, w: number, h: number): Rect {
  const x0 = Math.max(0, Math.floor(r.x / 2) * 2);
  const y0 = Math.max(0, Math.floor(r.y / 2) * 2);
  const x1 = Math.min(w, Math.ceil((r.x + r.w) / 2) * 2);
  const y1 = Math.min(h, Math.ceil((r.y + r.h) / 2) * 2);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * Two I420 frames kept up to date only inside the area the killfeed touched: the color (BT.601,
 * limited range, VP9's default) and the alpha plane as luma with full-range values, as WebM alpha expects.
 */
class AlphaPlanes {
  color: Uint8Array;
  alpha: Uint8Array;
  private last: Rect | null = null;
  constructor(
    private w: number,
    private h: number,
  ) {
    const size = w * h + 2 * (w / 2) * (h / 2);
    this.color = new Uint8Array(size);
    this.alpha = new Uint8Array(size);
    this.fill({ x: 0, y: 0, w, h });
  }
  /** Reset an area to transparent black. */
  private fill(r: Rect): void {
    const { w, h } = this;
    const cw = w / 2;
    for (let y = r.y; y < r.y + r.h; y++) {
      this.color.fill(16, y * w + r.x, y * w + r.x + r.w);
      this.alpha.fill(0, y * w + r.x, y * w + r.x + r.w);
    }
    for (let y = r.y / 2; y < (r.y + r.h) / 2; y++) {
      for (const base of [w * h, w * h + cw * (h / 2)]) {
        this.color.fill(128, base + y * cw + r.x / 2, base + y * cw + (r.x + r.w) / 2);
        this.alpha.fill(128, base + y * cw + r.x / 2, base + y * cw + (r.x + r.w) / 2);
      }
    }
  }
  update(ctx: OffscreenCanvasRenderingContext2D, rect: Rect | null): void {
    const { w, h } = this;
    if (this.last) this.fill(this.last);
    this.last = rect ? evenRect(rect, w, h) : null;
    const r = this.last;
    if (!r || !r.w || !r.h) return;
    // getImageData returns unpremultiplied colors, so faded text keeps its color and gets its alpha.
    const px = ctx.getImageData(r.x, r.y, r.w, r.h).data;
    const cw = w / 2;
    const uBase = w * h;
    const vBase = uBase + cw * (h / 2);
    for (let y = 0; y < r.h; y += 2) {
      for (let x = 0; x < r.w; x += 2) {
        let us = 0;
        let vs = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const i = ((y + dy) * r.w + x + dx) * 4;
            const R = px[i];
            const G = px[i + 1];
            const B = px[i + 2];
            const A = px[i + 3];
            const o = (r.y + y + dy) * w + r.x + x + dx;
            this.color[o] = (16 + (65.738 * R + 129.057 * G + 25.064 * B) / 256 + 0.5) | 0;
            this.alpha[o] = A;
            us += -37.945 * R - 74.494 * G + 112.439 * B;
            vs += 112.439 * R - 94.154 * G - 18.285 * B;
          }
        }
        const c = ((r.y + y) / 2) * cw + (r.x + x) / 2;
        this.color[uBase + c] = (128 + us / 1024 + 0.5) | 0;
        this.color[vBase + c] = (128 + vs / 1024 + 0.5) | 0;
      }
    }
  }
}

async function exportWebm(job: ExportJob): Promise<Blob> {
  const { width: w, height: h, fps } = job;
  if (w % 2 || h % 2) throw new Error("Width and height must be even.");
  const cfg = { width: w, height: h, bitrate: job.bitrate * 1e6, framerate: fps, latencyMode: "quality" as const };
  const codec = await pickCodec(["vp09.00.51.08", "vp09.00.41.08", "vp09.00.40.08", "vp8"], cfg);
  const writer = new WebmWriter(w, h, codec === "vp8" ? "V_VP8" : "V_VP9", true, 1000 / fps);
  const colors: EncodedVideoChunk[] = [];
  const alphas: EncodedVideoChunk[] = [];
  let failure: Error | null = null;
  const onError = (e: Error) => (failure = e);
  const flushPairs = () => {
    while (colors.length && alphas.length) {
      const c = colors.shift()!;
      const a = alphas.shift()!;
      const cb = new Uint8Array(c.byteLength);
      c.copyTo(cb);
      const ab = new Uint8Array(a.byteLength);
      a.copyTo(ab);
      // A key color frame needs a key alpha frame; both encoders get the same key requests.
      writer.add({ time: c.timestamp / 1000, key: c.type === "key", color: cb, alpha: ab });
    }
  };
  const colorEnc = new VideoEncoder({ output: (c) => (colors.push(c), flushPairs()), error: onError });
  const alphaEnc = new VideoEncoder({ output: (c) => (alphas.push(c), flushPairs()), error: onError });
  colorEnc.configure({ ...cfg, codec });
  // The alpha plane is mostly flat: half the bitrate is plenty.
  alphaEnc.configure({ ...cfg, codec, bitrate: cfg.bitrate / 2 });

  const ctx = makeContext(job);
  const planes = new AlphaPlanes(w, h);
  const total = frameCount(job);
  const colorSpace: VideoColorSpaceInit = { primaries: "smpte170m", transfer: "smpte170m", matrix: "smpte170m", fullRange: false };
  let lastKey = "";
  for (let i = 0; i < total; i++) {
    if (job.signal.aborted) throw new DOMException("Export cancelled", "AbortError");
    if (failure) throw failure;
    const t = job.from + (i * 1000) / fps;
    ctx.clearRect(0, 0, w, h);
    const frame = job.draw(ctx, t);
    if (frame.key !== lastKey || i === 0) planes.update(ctx, frame.rect);
    lastKey = frame.key;
    const timestamp = Math.round((i * 1e6) / fps);
    const key = i % (fps * 2) === 0;
    const init = { format: "I420" as const, codedWidth: w, codedHeight: h, timestamp, colorSpace };
    const cf = new VideoFrame(planes.color, init);
    const af = new VideoFrame(planes.alpha, init);
    colorEnc.encode(cf, { keyFrame: key });
    alphaEnc.encode(af, { keyFrame: key });
    cf.close();
    af.close();
    await waitQueue(colorEnc);
    await waitQueue(alphaEnc);
    if (i % 30 === 0) {
      job.onProgress(i, total);
      await yieldToBrowser();
    }
  }
  await colorEnc.flush();
  await alphaEnc.flush();
  colorEnc.close();
  alphaEnc.close();
  if (failure) throw failure;
  flushPairs();
  job.onProgress(total, total);
  return writer.finish();
}

async function exportMp4(job: ExportJob): Promise<Blob> {
  const { width: w, height: h, fps } = job;
  const cfg = { width: w, height: h, bitrate: job.bitrate * 1e6, framerate: fps, latencyMode: "quality" as const };
  const codec = await pickCodec(["avc1.640033", "avc1.640032", "avc1.640028", "avc1.4d0028"], cfg);
  const target = new Mp4Target();
  const muxer = new Mp4Muxer({ target, video: { codec: "avc", width: w, height: h, frameRate: fps }, fastStart: "in-memory" });
  let failure: Error | null = null;
  const enc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (failure = e) });
  enc.configure({ ...cfg, codec, avc: { format: "avc" } });
  const ctx = makeContext(job);
  const total = frameCount(job);
  for (let i = 0; i < total; i++) {
    if (job.signal.aborted) throw new DOMException("Export cancelled", "AbortError");
    if (failure) throw failure;
    const t = job.from + (i * 1000) / fps;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = job.background;
    ctx.fillRect(0, 0, w, h);
    job.draw(ctx, t);
    const vf = new VideoFrame(ctx.canvas, { timestamp: Math.round((i * 1e6) / fps) });
    enc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
    vf.close();
    await waitQueue(enc);
    if (i % 30 === 0) {
      job.onProgress(i, total);
      await yieldToBrowser();
    }
  }
  await enc.flush();
  enc.close();
  if (failure) throw failure;
  muxer.finalize();
  job.onProgress(total, total);
  return new Blob([target.buffer], { type: "video/mp4" });
}

async function exportPng(job: ExportJob): Promise<Blob> {
  const total = frameCount(job);
  if (total > 65000) throw new Error(`A PNG sequence of ${total} frames is too long for one zip: pick a shorter range.`);
  const ctx = makeContext(job);
  const zip = new ZipWriter();
  const digits = String(total).length;
  let lastKey = "";
  let last: Uint8Array | null = null;
  for (let i = 0; i < total; i++) {
    if (job.signal.aborted) throw new DOMException("Export cancelled", "AbortError");
    const t = job.from + (i * 1000) / job.fps;
    ctx.clearRect(0, 0, job.width, job.height);
    const frame = job.draw(ctx, t);
    // Identical frames (nothing moving) reuse the previous PNG.
    if (!last || frame.key !== lastKey) last = new Uint8Array(await (await (ctx.canvas as OffscreenCanvas).convertToBlob({ type: "image/png" })).arrayBuffer());
    lastKey = frame.key;
    zip.add(`killfeed_${String(i).padStart(digits, "0")}.png`, last);
    if (i % 30 === 0) {
      job.onProgress(i, total);
      await yieldToBrowser();
    }
  }
  job.onProgress(total, total);
  return zip.finish();
}
