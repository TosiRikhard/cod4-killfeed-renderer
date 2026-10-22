import type { IconManifest, FontFile, IconRatio } from "../extract/assets.ts";
import { killIconName, TEAM_ALLIES, TEAM_AXIS, type Killfeed, type KillfeedEntry } from "../demo/killfeed.ts";
import { stripColors } from "../demo/text.ts";
import { frameCount, runExport, type Rect } from "./export.ts";
import {
  DEFAULT_STYLE,
  lineOrigin,
  linePieces,
  placeLines,
  renderLine,
  type Assets,
  type FeedLine,
  type GameFont,
  type LineContext,
  type RenderedLine,
  type Style,
} from "./render.ts";
import type { PlayerInfo, WorkerReply } from "./worker.ts";
import { ZipWriter } from "./zip.ts";

declare const __WORKER_SOURCE__: string;

/** Extracted game assets, inlined into the page at build time (see scripts/build-killfeed.mjs). */
interface EmbeddedAssets {
  manifest: IconManifest | null;
  icons: Record<string, string>;
  fonts: FontFile | null;
  atlas: string | null;
  strings: Record<string, string>;
}
const EMBEDDED: EmbeddedAssets = (window as unknown as { __KILLFEED_ASSETS__?: EmbeddedAssets }).__KILLFEED_ASSETS__ ?? {
  manifest: null,
  icons: {},
  fonts: null,
  atlas: null,
  strings: {},
};

// ---------------------------------------------------------------- settings

interface FeedOptions {
  filter: "all" | "involving" | "by";
  messages: boolean;
  hideKillcam: boolean;
}
interface ExportOptions {
  format: "webm" | "png" | "mp4";
  resolution: string;
  fps: number;
  background: string;
  bitrate: number;
}
interface Settings {
  style: Style;
  feed: FeedOptions;
  export: ExportOptions;
  preview: { bg: string };
}
const DEFAULTS: Settings = {
  style: { ...DEFAULT_STYLE },
  feed: { filter: "all", messages: false, hideKillcam: true },
  export: { format: "webm", resolution: "1920x1080", fps: 60, background: "#00ff00", bitrate: 12 },
  preview: { bg: "checker" },
};
const STORE = "cod4-killfeed.settings.v1";
const ICON_STORE = "cod4-killfeed.icons.v1";

function storageGet<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function storageSet(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const saved = storageGet<Partial<Settings>>(STORE);
const settings: Settings = {
  style: { ...DEFAULTS.style, ...saved?.style },
  feed: { ...DEFAULTS.feed, ...saved?.feed },
  export: { ...DEFAULTS.export, ...saved?.export },
  preview: { ...DEFAULTS.preview, ...saved?.preview },
};
const persist = () => storageSet(STORE, settings);

// ---------------------------------------------------------------- dom helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const view = $<HTMLCanvasElement>("view");
const status = $("status");
function setStatus(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle("error", error);
}
function download(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
function fmtTime(ms: number, decimals = 1): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0");
  return `${m}:${rest}`;
}
function parseTime(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
}
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}
function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------- assets

interface IconOverride {
  data: string;
}
interface IconStore {
  images: Record<string, IconOverride>;
  ratios: Record<string, IconRatio>;
  flips: Record<string, boolean>;
  weapons: Record<string, string>;
  deaths: Record<string, string>;
}
const iconStore: IconStore = { images: {}, ratios: {}, flips: {}, weapons: {}, deaths: {}, ...storageGet<Partial<IconStore>>(ICON_STORE) };
const baseManifest: IconManifest = EMBEDDED.manifest ?? { version: 1, icons: {}, weapons: { default: "skull" }, deaths: {} };

const assets: Assets = { atlas: null, atlasSize: [1, 1], fonts: {}, icons: {}, weapons: {}, deaths: {} };
/** Current source (data URL) of each icon, for the icon panel and the icon pack. */
const iconSources: Record<string, string> = {};

async function loadAssets(): Promise<void> {
  if (EMBEDDED.atlas && EMBEDDED.fonts) {
    assets.atlas = await loadImage(EMBEDDED.atlas);
    assets.atlasSize = [EMBEDDED.fonts.width, EMBEDDED.fonts.height];
    for (const [name, f] of Object.entries(EMBEDDED.fonts.fonts)) {
      const glyphs = new Map<number, GameFont["glyphs"] extends Map<number, infer G> ? G : never>();
      for (const [letter, x0, y0, dx, w, h, s0, t0, s1, t1] of f.glyphs) glyphs.set(letter, { x0, y0, dx, w, h, s0, t0, s1, t1 });
      assets.fonts[name] = { name, pixelHeight: f.pixelHeight, glyphs };
    }
  }
  await rebuildIcons();
}

function iconNames(): string[] {
  return [...new Set([...Object.keys(baseManifest.icons), ...Object.keys(iconStore.images)])];
}

async function rebuildIcons(): Promise<void> {
  assets.weapons = { ...baseManifest.weapons, ...iconStore.weapons };
  assets.deaths = { ...baseManifest.deaths, ...iconStore.deaths };
  assets.icons = {};
  for (const name of iconNames()) {
    const src = iconStore.images[name]?.data ?? EMBEDDED.icons[name];
    if (!src) continue;
    try {
      const image = await loadImage(src);
      const ratio = iconStore.ratios[name] ?? baseManifest.icons[name]?.ratio ?? "1:1";
      const flip = iconStore.flips[name] ?? baseManifest.icons[name]?.flip ?? false;
      assets.icons[name] = { image, ratio, flip };
      iconSources[name] = src;
    } catch {
      // A broken custom image falls back to the outline box.
    }
  }
  invalidate();
}

function saveIcons(): void {
  if (!storageSet(ICON_STORE, iconStore)) setStatus("Custom icons are too large to remember in this browser; they work until you close the page.", true);
}

// ---------------------------------------------------------------- demo state

let killfeed: Killfeed | null = null;
let players: PlayerInfo[] = [];
let demoName = "";
let focus = -1;
const excluded = new Set<number>();
let entryIndex = new Map<KillfeedEntry, number>();
let lines: FeedLine[] = [];
let now = 0;
let playing = false;
let exportRange: { from: number | null; to: number | null } = { from: null, to: null };

function teamAt(client: number, time: number): number {
  const p = players.find((x) => x.client === client);
  if (!p) return -1;
  let team = p.teams[0]?.[1] ?? -1;
  for (const [t, v] of p.teams) if (t <= time) team = v;
  return team;
}
function playerLabel(p: PlayerInfo): string {
  return `${p.names.map(stripColors).join(" / ") || `#${p.client}`}${killfeed && p.client === killfeed.recorder ? "  (recorder)" : ""}`;
}

function included(e: KillfeedEntry, i: number): boolean {
  if (excluded.has(i)) return false;
  if (e.type === "message") return settings.feed.messages;
  if (settings.feed.hideKillcam && e.killcam) return false;
  if (settings.feed.filter === "involving") return e.attacker?.client === focus || e.victim.client === focus;
  if (settings.feed.filter === "by") return e.attacker?.client === focus;
  return true;
}

function rebuildLines(): void {
  if (!killfeed) {
    lines = [];
    return;
  }
  const s = settings.style;
  lines = killfeed.entries
    .map((entry, i) => ({ entry, i }))
    .filter(({ entry, i }) => included(entry, i))
    .map(({ entry }) => ({ entry, start: entry.time, end: s.keep ? Infinity : entry.time + s.msgTime * 1000 }));
}

// ---------------------------------------------------------------- drawing

let lineCache = new Map<KillfeedEntry, RenderedLine>();
let cacheHeight = 0;
function invalidate(): void {
  lineCache = new Map();
  rebuildLines();
  renderMarks();
  renderList();
  redraw();
}

function lineContext(): LineContext {
  return { style: settings.style, assets, viewTeam: (e) => e.viewTeam, focusClient: focus };
}

/** Draw the killfeed at time t onto a transparent canvas of the output size. */
function drawFeed(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, t: number, w: number, h: number): { key: string; rect: Rect | null } {
  if (h !== cacheHeight) {
    lineCache = new Map();
    cacheHeight = h;
  }
  const s = settings.style;
  const placed = placeLines(lines, t, s, killfeed?.rounds ?? []);
  const lc = lineContext();
  let rect: Rect | null = null;
  const keys: string[] = [];
  for (const p of placed) {
    if (p.alpha <= 0) continue;
    let rl = lineCache.get(p.line.entry);
    if (!rl) lineCache.set(p.line.entry, (rl = renderLine(linePieces(p.line.entry, lc), lc, h)));
    const [ox, oy] = lineOrigin(s, p.y, w, h);
    const dx = Math.round(ox - rl.originX);
    const dy = Math.round(oy - rl.originY);
    ctx.globalAlpha = Math.min(1, p.alpha);
    ctx.drawImage(rl.canvas, dx, dy);
    ctx.globalAlpha = 1;
    keys.push(`${entryIndex.get(p.line.entry)}:${dy}:${p.alpha.toFixed(3)}`);
    const r = { x: dx, y: dy, w: rl.canvas.width, h: rl.canvas.height };
    rect = rect
      ? {
          x: Math.min(rect.x, r.x),
          y: Math.min(rect.y, r.y),
          w: Math.max(rect.x + rect.w, r.x + r.w) - Math.min(rect.x, r.x),
          h: Math.max(rect.y + rect.h, r.y + r.h) - Math.min(rect.y, r.y),
        }
      : r;
  }
  return { key: keys.join("|"), rect };
}

function outputSize(): [number, number] {
  const [w, h] = settings.export.resolution.split("x").map(Number);
  return [w || 1920, h || 1080];
}

let lastVisible = "";
function redraw(): void {
  const [w, h] = outputSize();
  if (view.width !== w || view.height !== h) {
    view.width = w;
    view.height = h;
  }
  const ctx = view.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  if (!killfeed) {
    drawSample(ctx, w, h);
    return;
  }
  const { key } = drawFeed(ctx, now, w, h);
  $("time").textContent = `${fmtTime(now)} / ${fmtTime(killfeed.durationMs, 0)}`;
  ($("scrub") as HTMLInputElement).value = String(Math.round(now));
  if (key !== lastVisible) {
    lastVisible = key;
    const onScreen = new Set(key ? key.split("|").map((k) => Number(k.split(":")[0])) : []);
    for (const tr of document.querySelectorAll<HTMLTableRowElement>("#list tr.entry")) tr.classList.toggle("current", onScreen.has(Number(tr.dataset.i)));
  }
}

/** Before a demo is loaded: a few made-up lines so the look can be tuned. */
function drawSample(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const p = (client: number, name: string, team: number) => ({ client, name, team });
  const base = { killcam: false, viewClient: 1, viewTeam: TEAM_ALLIES, mod: -1 };
  const sample: KillfeedEntry[] = [
    { type: "obituary", time: 0, ...base, attacker: p(1, "Banana", TEAM_ALLIES), victim: p(2, "STEELM@N", TEAM_AXIS), weapon: "m40a3_mp", death: "", kind: "kill" },
    { type: "obituary", time: 0, ...base, attacker: p(3, "^1Ferran", TEAM_AXIS), victim: p(4, "{HamsteR}LQA", TEAM_ALLIES), weapon: "gl_m4_mp", death: "", kind: "kill" },
    { type: "obituary", time: 0, ...base, attacker: p(1, "Banana", TEAM_ALLIES), victim: p(5, "Angst", TEAM_AXIS), weapon: "", death: "headshot", mod: 8, kind: "kill" },
    { type: "obituary", time: 0, ...base, attacker: p(1, "Banana", TEAM_ALLIES), victim: p(6, "TiKi", TEAM_AXIS), weapon: "deserteagle_mp", death: "", kind: "kill" },
  ];
  const s = settings.style;
  const lc: LineContext = { style: s, assets, viewTeam: (e) => e.viewTeam, focusClient: 1 };
  const n = Math.min(sample.length, s.lineCount);
  const charHeight = Math.round(s.textScale * 48);
  for (let i = 0; i < n; i++) {
    const rl = renderLine(linePieces(sample[sample.length - n + i], lc), lc, h);
    const [ox, oy] = lineOrigin(s, s.y - (n - 1 - i) * charHeight, w, h);
    ctx.drawImage(rl.canvas, Math.round(ox - rl.originX), Math.round(oy - rl.originY));
  }
}

// ---------------------------------------------------------------- list + timeline

function colorFor(entry: KillfeedEntry, who: { client: number; team: number }): string {
  const s = settings.style;
  if (s.highlightFocus && who.client === focus) return s.focusColor;
  const view = entry.viewTeam;
  const teams = (t: number) => t === TEAM_AXIS || t === TEAM_ALLIES;
  if (!teams(who.team) || !teams(view)) return s.neutral;
  const mine = s.colorMode === "custom" ? s.friendly : view === TEAM_AXIS ? s.axis : s.allies;
  const theirs = s.colorMode === "custom" ? s.enemy : view === TEAM_AXIS ? s.allies : s.axis;
  return who.team === view ? mine : theirs;
}

function renderList(): void {
  const body = $("list");
  body.textContent = "";
  if (!killfeed) return;
  const frag = document.createDocumentFragment();
  killfeed.entries.forEach((e, i) => {
    if (e.type === "message" && !settings.feed.messages) return;
    const tr = document.createElement("tr");
    tr.className = "entry";
    tr.dataset.i = String(i);
    if (!included(e, i)) tr.classList.add("hidden");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = !excluded.has(i);
    check.title = "Include this line";
    check.addEventListener("click", (ev) => ev.stopPropagation());
    check.addEventListener("change", () => {
      if (check.checked) excluded.delete(i);
      else excluded.add(i);
      invalidate();
    });
    const td = (cls = "", text = "", color = "") => {
      const c = document.createElement("td");
      if (cls) c.className = cls;
      c.textContent = text;
      if (color) c.style.color = color;
      return c;
    };
    const first = document.createElement("td");
    first.append(check);
    tr.append(first, td("t", fmtTime(e.time)));
    if (e.type === "message") {
      const msg = td("", stripColors(e.text));
      msg.colSpan = 3;
      tr.append(msg, td("tag", "notification"));
    } else {
      tr.append(td("name", e.attacker ? stripColors(e.attacker.name) : "", e.attacker ? colorFor(e, e.attacker) : ""));
      const icon = td("ic");
      const name = killIconName(e, assets);
      if (iconSources[name]) {
        const img = document.createElement("img");
        img.src = iconSources[name];
        img.alt = e.weapon || e.death;
        img.title = e.weapon || e.death;
        if (!e.death && assets.icons[name]?.flip) img.style.transform = "scaleX(-1)";
        icon.append(img);
      } else icon.textContent = e.weapon || e.death;
      tr.append(icon, td("name", stripColors(e.victim.name), colorFor(e, e.victim)));
      tr.append(td("tag", e.killcam ? "killcam" : e.kind === "teamkill" ? "teamkill" : e.kind === "suicide" ? "suicide" : ""));
    }
    tr.addEventListener("click", () => seek(e.time + 600));
    frag.append(tr);
  });
  body.append(frag);
  lastVisible = "";
}

function renderMarks(): void {
  const marks = $("marks");
  marks.textContent = "";
  if (!killfeed || !killfeed.durationMs) return;
  for (const l of lines) {
    const i = document.createElement("i");
    i.style.left = `${(l.start / killfeed.durationMs) * 100}%`;
    const e = l.entry;
    if (e.type === "obituary" && (e.attacker?.client === focus || e.victim.client === focus)) i.className = "focus";
    marks.append(i);
  }
}

function seek(t: number): void {
  if (!killfeed) return;
  now = Math.max(0, Math.min(killfeed.durationMs, t));
  redraw();
}

let lastFrame = 0;
function tick(ts: number): void {
  if (playing && killfeed) {
    const dt = lastFrame ? ts - lastFrame : 0;
    now += dt * Number(($("speed") as HTMLSelectElement).value);
    if (now >= killfeed.durationMs) {
      now = killfeed.durationMs;
      setPlaying(false);
    }
    redraw();
  }
  lastFrame = ts;
  requestAnimationFrame(tick);
}
function setPlaying(p: boolean): void {
  playing = p && !!killfeed;
  $("play").textContent = playing ? "⏸" : "▶";
}

function jump(direction: 1 | -1): void {
  if (!lines.length) return;
  const starts = lines.map((l) => l.start);
  const target = direction > 0 ? starts.find((s) => s > now + 50) : [...starts].reverse().find((s) => s < now - 700);
  if (target !== undefined) seek(target + (direction > 0 ? 600 : 600));
}

// ---------------------------------------------------------------- loading a demo

let worker: Worker | null = null;
function getWorker(): Worker {
  if (!worker) worker = new Worker(URL.createObjectURL(new Blob([__WORKER_SOURCE__], { type: "text/javascript" })));
  return worker;
}

async function openDemo(file: File): Promise<void> {
  setPlaying(false);
  setStatus(`Reading ${file.name}…`);
  $("demoInfo").textContent = `Reading ${file.name}…`;
  const buffer = await file.arrayBuffer();
  const w = getWorker();
  const reply = await new Promise<WorkerReply>((resolve) => {
    w.onmessage = (e: MessageEvent<WorkerReply>) => resolve(e.data);
    w.onerror = (e) => resolve({ ok: false, error: e.message || "The decoder crashed." });
    w.postMessage({ buffer, strings: EMBEDDED.strings }, [buffer]);
  });
  if (!reply.ok) {
    setStatus(`Could not read ${file.name}: ${reply.error}`, true);
    $("demoInfo").textContent = file.name;
    return;
  }
  killfeed = reply.killfeed;
  players = reply.players.sort((a, b) => a.client - b.client);
  demoName = file.name.replace(/\.dm_1$/i, "");
  entryIndex = new Map(killfeed.entries.map((e, i) => [e, i]));
  excluded.clear();
  focus = killfeed.recorder;
  exportRange = { from: null, to: null };
  ($("from") as HTMLInputElement).value = "";
  ($("to") as HTMLInputElement).value = "";
  // Server-sent team colors replace the defaults until the user picks their own.
  const hex = (c: number[]) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
  if (settings.style.allies === DEFAULT_STYLE.allies) settings.style.allies = hex(killfeed.teamColors.allies);
  if (settings.style.axis === DEFAULT_STYLE.axis) settings.style.axis = hex(killfeed.teamColors.axis);

  const focusSel = $<HTMLSelectElement>("focus");
  focusSel.textContent = "";
  for (const p of players) focusSel.append(new Option(playerLabel(p), String(p.client), false, p.client === focus));
  const obits = killfeed.entries.filter((e) => e.type === "obituary");
  const maps = [...new Set(killfeed.maps.map((m) => `${m.map} (${m.gametype})`))].join(", ");
  $("demoInfo").textContent = `${file.name} — ${maps} — ${fmtTime(killfeed.durationMs, 0)} — ${obits.length} kills`;
  setStatus(`Decoded in ${(reply.decodeMs / 1000).toFixed(1)} s. ${obits.filter((e) => e.killcam).length} killcam replays found.`);
  $("drop").style.display = "none";
  for (const id of ["play", "prev", "next", "scrub", "export", "snapshot", "saveJson", "saveCsv"]) ($(id) as HTMLButtonElement).disabled = false;
  ($("scrub") as HTMLInputElement).max = String(killfeed.durationMs);
  syncControls();
  invalidate();
  const first = lines.find((l) => l.entry.type === "obituary");
  seek(first ? first.start + 600 : 0);
}

// ---------------------------------------------------------------- controls

type Binding = { id: string; get: () => string | number | boolean; set: (v: string, checked: boolean) => void };
const bind = <K extends keyof Style>(id: string, key: K, kind: "number" | "text" | "check" = "number"): Binding => ({
  id,
  get: () => settings.style[key] as never,
  set: (v, checked) => {
    (settings.style[key] as unknown) = kind === "check" ? checked : kind === "number" ? Number(v) : v;
  },
});
const bindings: Binding[] = [
  bind("keep", "keep", "check"),
  bind("clearOnRound", "clearOnRound", "check"),
  bind("lineCount", "lineCount"),
  bind("msgTime", "msgTime"),
  bind("fadeIn", "fadeIn"),
  bind("fadeOut", "fadeOut"),
  bind("scrollTime", "scrollTime"),
  bind("colorMode", "colorMode", "text"),
  bind("allies", "allies", "text"),
  bind("axis", "axis", "text"),
  bind("friendly", "friendly", "text"),
  bind("enemy", "enemy", "text"),
  bind("neutral", "neutral", "text"),
  bind("highlightFocus", "highlightFocus", "check"),
  bind("focusColor", "focusColor", "text"),
  bind("nameColors", "nameColors", "check"),
  bind("shadow", "shadow", "check"),
  bind("shadowOffset", "shadowOffset"),
  bind("font", "font", "text"),
  bind("textScale", "textScale"),
  bind("iconScale", "iconScale"),
  bind("posX", "x"),
  bind("posY", "y"),
  {
    id: "filter",
    get: () => settings.feed.filter,
    set: (v) => (settings.feed.filter = v as FeedOptions["filter"]),
  },
  { id: "messages", get: () => settings.feed.messages, set: (_, c) => (settings.feed.messages = c) },
  { id: "hideKillcam", get: () => settings.feed.hideKillcam, set: (_, c) => (settings.feed.hideKillcam = c) },
  { id: "format", get: () => settings.export.format, set: (v) => (settings.export.format = v as ExportOptions["format"]) },
  { id: "resolution", get: () => settings.export.resolution, set: (v) => (settings.export.resolution = v) },
  { id: "fps", get: () => String(settings.export.fps), set: (v) => (settings.export.fps = Number(v)) },
  { id: "background", get: () => settings.export.background, set: (v) => (settings.export.background = v) },
  { id: "bitrate", get: () => settings.export.bitrate, set: (v) => (settings.export.bitrate = Number(v)) },
  { id: "bg", get: () => settings.preview.bg, set: (v) => (settings.preview.bg = v) },
];

function syncControls(): void {
  for (const b of bindings) {
    const el = $<HTMLInputElement>(b.id);
    const v = b.get();
    if (el.type === "checkbox") el.checked = Boolean(v);
    else el.value = String(v);
  }
  const custom = settings.style.colorMode === "custom";
  for (const el of document.querySelectorAll<HTMLElement>(".game-colors")) el.hidden = custom;
  for (const el of document.querySelectorAll<HTMLElement>(".custom-colors")) el.hidden = !custom;
  for (const el of document.querySelectorAll<HTMLElement>(".mp4-only")) el.hidden = settings.export.format !== "mp4";
  ($("msgTime") as HTMLInputElement).disabled = settings.style.keep;
  ($("fadeOut") as HTMLInputElement).disabled = settings.style.keep;
  const focusOff = settings.feed.filter === "all" && !settings.style.highlightFocus;
  ($("focus") as HTMLSelectElement).disabled = !killfeed || focusOff;
  applyPreviewBackground();
  ($("export") as HTMLButtonElement).textContent = settings.export.format === "png" ? "Export PNG sequence" : "Export video";
}

for (const b of bindings) {
  const el = $<HTMLInputElement>(b.id);
  el.addEventListener(el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input", () => {
    if (el.type === "number" && (el.value === "" || !Number.isFinite(Number(el.value)))) return;
    b.set(el.value, el.checked);
    persist();
    syncControls();
    invalidate();
  });
}
$<HTMLSelectElement>("focus").addEventListener("change", (e) => {
  focus = Number((e.target as HTMLSelectElement).value);
  invalidate();
});
$("resetTiming").addEventListener("click", () => {
  for (const k of ["keep", "clearOnRound", "lineCount", "msgTime", "fadeIn", "fadeOut", "scrollTime"] as const) (settings.style[k] as unknown) = DEFAULT_STYLE[k];
  persist();
  syncControls();
  invalidate();
});
$("resetColors").addEventListener("click", () => {
  for (const k of ["colorMode", "allies", "axis", "friendly", "enemy", "neutral", "highlightFocus", "focusColor", "nameColors", "shadow", "shadowOffset"] as const)
    (settings.style[k] as unknown) = DEFAULT_STYLE[k];
  if (killfeed) {
    const hex = (c: number[]) => "#" + c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    settings.style.allies = hex(killfeed.teamColors.allies);
    settings.style.axis = hex(killfeed.teamColors.axis);
  }
  persist();
  syncControls();
  invalidate();
});
$("resetLayout").addEventListener("click", () => {
  for (const k of ["font", "textScale", "iconScale", "x", "y"] as const) (settings.style[k] as unknown) = DEFAULT_STYLE[k];
  persist();
  syncControls();
  invalidate();
});

// Preview background
let bgImageUrl = "";
function applyPreviewBackground(): void {
  const stage = $("stage");
  const img = $<HTMLImageElement>("bgImage");
  const bg = settings.preview.bg;
  stage.classList.toggle("checker", bg === "checker" || (bg === "image" && !bgImageUrl));
  stage.style.backgroundColor = bg === "green" ? "#00ff00" : bg === "black" ? "#000" : "";
  img.style.display = bg === "image" && bgImageUrl ? "block" : "none";
}
$("bg").addEventListener("change", () => {
  if (settings.preview.bg === "image" && !bgImageUrl) $("bgInput").click();
});
$<HTMLInputElement>("bgInput").addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) setBackgroundImage(f);
});
function setBackgroundImage(f: File): void {
  if (bgImageUrl) URL.revokeObjectURL(bgImageUrl);
  bgImageUrl = URL.createObjectURL(f);
  $<HTMLImageElement>("bgImage").src = bgImageUrl;
  settings.preview.bg = "image";
  syncControls();
}

// Preview zoom: scale the canvas (and background image) around the bottom-left corner, where the feed is.
$<HTMLSelectElement>("zoom").addEventListener("change", (e) => {
  const z = (e.target as HTMLSelectElement).value;
  for (const el of [view, $("bgImage")]) el.style.transform = z === "1" ? "" : `scale(${z})`;
});

// Transport
$("play").addEventListener("click", () => setPlaying(!playing));
$("prev").addEventListener("click", () => jump(-1));
$("next").addEventListener("click", () => jump(1));
$<HTMLInputElement>("scrub").addEventListener("input", (e) => seek(Number((e.target as HTMLInputElement).value)));
document.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.code === "Space") {
    e.preventDefault();
    setPlaying(!playing);
  } else if (e.code === "ArrowRight") jump(1);
  else if (e.code === "ArrowLeft") jump(-1);
});

// Files: drop anywhere. Demos load; images dropped on the preview become its background.
$<HTMLInputElement>("fileInput").addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void openDemo(f);
});
document.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dragging");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const f = e.dataTransfer?.files[0];
  if (!f) return;
  if (f.type.startsWith("image/") && (e.target as HTMLElement).closest("#stage")) setBackgroundImage(f);
  else if (!f.type.startsWith("image/")) void openDemo(f);
});

// ---------------------------------------------------------------- icons panel

let iconTarget = "";
function renderIcons(): void {
  const box = $("icons");
  box.textContent = "";
  for (const name of iconNames()) {
    const card = document.createElement("div");
    card.className = "icon" + (iconStore.images[name] ? " custom" : "");
    card.title = `${name}: click or drop a PNG to replace${iconStore.images[name] ? " (custom; right-click to reset)" : ""}`;
    const img = document.createElement("img");
    if (iconSources[name]) img.src = iconSources[name];
    img.alt = name;
    const label = document.createElement("span");
    label.textContent = name;
    const ratio = document.createElement("select");
    for (const r of ["1:1", "2:1", "4:1"]) ratio.append(new Option(r, r));
    ratio.value = assets.icons[name]?.ratio ?? iconStore.ratios[name] ?? baseManifest.icons[name]?.ratio ?? "1:1";
    ratio.title = "Kill icon shape";
    ratio.addEventListener("click", (e) => e.stopPropagation());
    ratio.addEventListener("change", async () => {
      iconStore.ratios[name] = ratio.value as IconRatio;
      saveIcons();
      await rebuildIcons();
    });
    const flip = document.createElement("button");
    flip.textContent = "⇄";
    flip.title = "Mirror the icon (the game mirrors gun icons so they point at the victim)";
    const flipped = assets.icons[name]?.flip ?? false;
    flip.style.cssText = `padding:0 6px;font-size:11px;${flipped ? "border-color:var(--accent);color:var(--accent)" : ""}`;
    if (flipped) img.style.transform = "scaleX(-1)";
    flip.addEventListener("click", async (e) => {
      e.stopPropagation();
      iconStore.flips[name] = !flipped;
      saveIcons();
      await rebuildIcons();
      renderIcons();
    });
    const controls = document.createElement("div");
    controls.className = "pair";
    controls.append(ratio, flip);
    card.append(img, label, controls);
    card.addEventListener("click", () => {
      iconTarget = name;
      $("iconInput").click();
    });
    card.addEventListener("contextmenu", async (e) => {
      if (!iconStore.images[name]) return;
      e.preventDefault();
      delete iconStore.images[name];
      delete iconStore.ratios[name];
      delete iconStore.flips[name];
      saveIcons();
      await rebuildIcons();
      renderIcons();
    });
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.add("dragover");
    });
    card.addEventListener("dragleave", () => card.classList.remove("dragover"));
    card.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove("dragover");
      document.body.classList.remove("dragging");
      const f = e.dataTransfer?.files[0];
      if (f) await setIcon(name, f);
    });
    box.append(card);
  }
}
async function setIcon(name: string, file: Blob): Promise<void> {
  iconStore.images[name] = { data: await readAsDataURL(file) };
  saveIcons();
  await rebuildIcons();
  renderIcons();
}
$<HTMLInputElement>("iconInput").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = "";
  if (f && iconTarget) await setIcon(iconTarget, f);
});
$<HTMLInputElement>("iconFolder").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  const manifestFile = files.find((f) => f.name.toLowerCase() === "icons.json");
  if (manifestFile) {
    try {
      const m = JSON.parse(await manifestFile.text()) as Partial<IconManifest>;
      Object.assign(iconStore.weapons, m.weapons ?? {});
      Object.assign(iconStore.deaths, m.deaths ?? {});
      for (const [name, v] of Object.entries(m.icons ?? {})) {
        if (v?.ratio) iconStore.ratios[name] = v.ratio;
        if (typeof v?.flip === "boolean") iconStore.flips[name] = v.flip;
      }
    } catch {
      setStatus("icons.json in that folder is not valid JSON; loaded the images only.", true);
    }
  }
  let count = 0;
  for (const f of files) {
    if (!/\.(png|webp|gif|jpe?g)$/i.test(f.name)) continue;
    iconStore.images[f.name.replace(/\.[^.]+$/, "")] = { data: await readAsDataURL(f) };
    count++;
  }
  saveIcons();
  await rebuildIcons();
  renderIcons();
  setStatus(`Loaded ${count} icon${count === 1 ? "" : "s"}${manifestFile ? " and icons.json" : ""}.`);
});
$("iconReset").addEventListener("click", async () => {
  iconStore.images = {};
  iconStore.ratios = {};
  iconStore.flips = {};
  iconStore.weapons = {};
  iconStore.deaths = {};
  saveIcons();
  await rebuildIcons();
  renderIcons();
});
$("iconPack").addEventListener("click", async () => {
  const zip = new ZipWriter();
  const manifest: IconManifest = { version: 1, icons: {}, weapons: { ...assets.weapons }, deaths: { ...assets.deaths } };
  for (const name of iconNames()) {
    const src = iconSources[name];
    if (!src) continue;
    const img = assets.icons[name].image as HTMLImageElement;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d")!.drawImage(img, 0, 0);
    const png = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
    zip.add(`icons/${name}.png`, new Uint8Array(await png.arrayBuffer()));
    manifest.icons[name] = { file: `${name}.png`, ratio: assets.icons[name].ratio, ...(assets.icons[name].flip ? { flip: true } : {}) };
  }
  zip.add("icons/icons.json", new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n"));
  download(zip.finish(), "killfeed-icons.zip");
});

// ---------------------------------------------------------------- export

let abort: AbortController | null = null;
function rangeFromInputs(): { from: number; to: number } | null {
  if (!killfeed) return null;
  const from = parseTime(($("from") as HTMLInputElement).value) ?? 0;
  const to = parseTime(($("to") as HTMLInputElement).value) ?? killfeed.durationMs;
  if (!(to > from)) return null;
  return { from: Math.max(0, from), to: Math.min(killfeed.durationMs + 10000, to) };
}
$("fromHere").addEventListener("click", () => (($("from") as HTMLInputElement).value = fmtTime(now)));
$("toHere").addEventListener("click", () => (($("to") as HTMLInputElement).value = fmtTime(now)));
$("wholeDemo").addEventListener("click", () => {
  ($("from") as HTMLInputElement).value = "";
  ($("to") as HTMLInputElement).value = "";
});

$("export").addEventListener("click", async () => {
  const range = rangeFromInputs();
  if (!range || !killfeed) {
    setStatus("Check the from/to times (m:ss).", true);
    return;
  }
  const [w, h] = outputSize();
  const { format, fps, background, bitrate } = settings.export;
  const total = frameCount({ ...range, fps });
  setPlaying(false);
  abort = new AbortController();
  const progress = $<HTMLProgressElement>("progress");
  progress.hidden = false;
  progress.value = 0;
  ($("export") as HTMLButtonElement).disabled = true;
  $("cancel").hidden = false;
  const started = performance.now();
  setStatus(`Rendering ${total} frames…`);
  try {
    const blob = await runExport({
      kind: format,
      ...range,
      fps,
      width: w,
      height: h,
      background,
      bitrate,
      draw: (ctx, t) => drawFeed(ctx, t, w, h),
      onProgress: (done, all) => {
        progress.value = done / all;
        const secs = (performance.now() - started) / 1000;
        const eta = done ? (secs / done) * (all - done) : 0;
        setStatus(`Frame ${done} / ${all} — ${(done / Math.max(secs, 0.001)).toFixed(0)} fps — about ${Math.ceil(eta)} s left`);
      },
      signal: abort.signal,
    });
    const ext = format === "png" ? "zip" : format;
    const span = `${fmtTime(range.from, 0)}-${fmtTime(range.to, 0)}`.replace(/:/g, "m");
    download(blob, `${demoName}_killfeed_${w}x${h}_${fps}fps_${span}.${ext}`);
    setStatus(`Done: ${(blob.size / 1048576).toFixed(1)} MB in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
  } catch (err) {
    if ((err as Error).name === "AbortError") setStatus("Export cancelled.");
    else setStatus(`Export failed: ${(err as Error).message}`, true);
  } finally {
    progress.hidden = true;
    ($("export") as HTMLButtonElement).disabled = false;
    $("cancel").hidden = true;
    abort = null;
  }
});
$("cancel").addEventListener("click", () => abort?.abort());

$("snapshot").addEventListener("click", () => {
  view.toBlob((b) => b && download(b, `${demoName}_killfeed_${fmtTime(now).replace(/[:.]/g, "-")}.png`), "image/png");
});

function feedRows(): Record<string, string | number | boolean>[] {
  if (!killfeed) return [];
  return lines.map(({ entry: e }): Record<string, string | number | boolean> =>
    e.type === "message"
      ? { time: e.time / 1000, type: "message", text: stripColors(e.text) }
      : {
          time: e.time / 1000,
          type: "kill",
          attacker: e.attacker ? stripColors(e.attacker.name) : "",
          victim: stripColors(e.victim.name),
          weapon: e.weapon,
          death: e.death,
          icon: killIconName(e, assets),
          kind: e.kind,
          killcam: e.killcam,
        },
  );
}
$("saveJson").addEventListener("click", () =>
  download(new Blob([JSON.stringify(feedRows(), null, 2)], { type: "application/json" }), `${demoName}_killfeed.json`),
);
$("saveCsv").addEventListener("click", () => {
  const rows = feedRows();
  const cols = ["time", "type", "attacker", "victim", "weapon", "death", "icon", "kind", "killcam", "text"];
  const esc = (v: unknown) => (v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  download(new Blob([csv], { type: "text/csv" }), `${demoName}_killfeed.csv`);
});

// ---------------------------------------------------------------- start

async function start(): Promise<void> {
  const fontSel = $<HTMLSelectElement>("font");
  await loadAssets();
  for (const name of Object.keys(assets.fonts)) fontSel.append(new Option(name, name));
  if (!assets.atlas) setStatus("This build has no game assets: text uses a plain font and icons are boxes. See the README to add them.", true);
  syncControls();
  renderIcons();
  invalidate();
  requestAnimationFrame(tick);
}
void start();
