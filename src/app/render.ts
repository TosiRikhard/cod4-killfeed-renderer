/**
 * Draws the killfeed the way CoD4 does (cl_console.cpp / rb_backend.cpp):
 * a bottom-up message window whose new lines scroll in and fade in, expire after
 * a fixed time and fade out, drawn with the game's bitmap font and kill icons.
 */
import { killIconName, TEAM_ALLIES, TEAM_AXIS, type KillfeedEntry } from "../demo/killfeed.ts";

export interface Glyph {
  x0: number;
  y0: number;
  dx: number;
  w: number;
  h: number;
  s0: number;
  t0: number;
  s1: number;
  t1: number;
}
export interface GameFont {
  name: string;
  pixelHeight: number;
  glyphs: Map<number, Glyph>;
}
export interface Icon {
  image: CanvasImageSource;
  ratio: "1:1" | "2:1" | "4:1";
  /** Mirrored horizontally, like a weapon's flipKillIcon. */
  flip: boolean;
}
export interface Assets {
  atlas: CanvasImageSource | null;
  atlasSize: [number, number];
  fonts: Record<string, GameFont>;
  icons: Record<string, Icon>;
  weapons: Record<string, string>;
  deaths: Record<string, string>;
}

export interface Style {
  /** Virtual 640x480 HUD units, left-aligned: left edge of the text. */
  x: number;
  /** Virtual units from the bottom of the screen to the baseline of the newest line (negative = up). */
  y: number;
  /** Menu textscale; line height is round(textScale * 48) virtual units. */
  textScale: number;
  /** "auto" picks the font like UI_GetFontHandle does for the output resolution. */
  font: string;
  lineCount: number;
  /** Seconds a line stays; ignored when keep is set. */
  msgTime: number;
  fadeIn: number;
  fadeOut: number;
  scrollTime: number;
  /** Lines never expire (only pushed out by newer ones): the whole killfeed for fragmovies. */
  keep: boolean;
  /** Empty the window when a round or map starts. */
  clearOnRound: boolean;
  shadow: boolean;
  /** Shadow offset in output pixels (the game uses 1). */
  shadowOffset: number;
  /** Game: friendly = your team's color (allies or axis). Custom: fixed friendly/enemy colors. */
  colorMode: "game" | "custom";
  allies: string;
  axis: string;
  friendly: string;
  enemy: string;
  /** Names when there are no teams (free-for-all) and plain text. */
  neutral: string;
  /** Give the focus player's name its own color. */
  highlightFocus: boolean;
  focusColor: string;
  /** Honor ^1..^9 color codes inside player names. */
  nameColors: boolean;
  /** Extra icon size multiplier (1 = game). */
  iconScale: number;
}

export const DEFAULT_STYLE: Style = {
  // Fitted to 1440p game footage: line height 14 HUD units, text 5.67 units from the left edge.
  x: 5.67,
  y: -80.33,
  textScale: 0.29,
  font: "auto",
  lineCount: 4,
  msgTime: 5,
  fadeIn: 0.25,
  fadeOut: 0.5,
  scrollTime: 0.25,
  keep: false,
  clearOnRound: false,
  shadow: true,
  shadowOffset: 1,
  colorMode: "game",
  allies: "#99a3b0",
  axis: "#a69169",
  friendly: "#6699d9",
  enemy: "#bf4040",
  neutral: "#ffffff",
  highlightFocus: false,
  focusColor: "#ffd34d",
  nameColors: true,
  iconScale: 1,
};

/** ^0..^7 as the game draws them (rb_backend color_table). */
const CODE_COLORS = ["#000000", "#ff5c5c", "#00ff00", "#ffff00", "#0000ff", "#00ffff", "#ff5cff", ""];

/** What one killfeed line shows: runs of colored text and an icon. */
type Piece = { text: string; color: string } | { icon: string; w: number; h: number; flip: boolean };

export interface FeedLine {
  entry: KillfeedEntry;
  start: number;
  end: number;
}

/** One line on screen at a moment: where its baseline is (virtual units from the bottom) and its opacity. */
export interface PlacedLine {
  line: FeedLine;
  y: number;
  alpha: number;
}

/**
 * Lines on screen at time t (ms). Port of Con_DrawMessageWindowNewToOld (bottom-up) with
 * Con_GetMessageAlpha: every line still scrolling pushes the stack down by its remaining scroll.
 */
export function placeLines(lines: FeedLine[], t: number, s: Style, rounds: number[]): PlacedLine[] {
  // Newest lineCount lines that have started and not expired (older ones were pushed out).
  let hi = upperBound(lines, t);
  let roundStart = -Infinity;
  if (s.clearOnRound) for (const r of rounds) if (r <= t) roundStart = r;
  const active: FeedLine[] = [];
  for (let i = hi - 1; i >= 0 && active.length < s.lineCount; i--) {
    const l = lines[i];
    if (l.start < roundStart) break;
    if (t < l.end) active.unshift(l);
    else if (!s.keep) {
      // Lines expire oldest first; an expired line means everything older is gone too.
      break;
    }
  }
  const charHeight = Math.round(s.textScale * 48);
  const scroll = s.scrollTime * 1000;
  const fadeIn = s.fadeIn * 1000;
  const fadeOut = s.fadeOut * 1000;
  let y = s.y;
  for (const l of active) {
    const age = t - l.start;
    if (age < scroll) y += Math.round(charHeight * clamp01(1 - age / scroll));
  }
  const out: PlacedLine[] = [];
  for (let i = active.length - 1; i >= 0; i--) {
    const l = active[i];
    const age = t - l.start;
    let alpha = 1;
    if (!s.keep && l.end - t < fadeOut) alpha = (l.end - t) / fadeOut;
    if (fadeIn < scroll && age < scroll) alpha = age <= scroll - fadeIn ? 0 : (alpha * (age - (scroll - fadeIn))) / fadeIn;
    else if (fadeIn > 0 && age < fadeIn) alpha *= age / fadeIn;
    out.push({ line: l, y, alpha: Math.max(0, alpha) });
    y -= charHeight;
  }
  return out;
}

function upperBound(lines: FeedLine[], t: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The font UI_GetFontHandle picks for UI_FONT_DEFAULT at this scale (thresholds ui_smallFont/bigFont/extraBigFont). */
export function pickFont(assets: Assets, s: Style, outputHeight: number): GameFont | null {
  if (s.font !== "auto") return assets.fonts[s.font] ?? null;
  const scaled = (outputHeight / 480) * s.textScale;
  const name = scaled <= 0.25 ? "smallFont" : scaled < 0.4 ? "normalFont" : scaled < 0.55 ? "bigFont" : "extraBigFont";
  return assets.fonts[name] ?? Object.values(assets.fonts)[0] ?? null;
}

/** Split text with ^ color codes into colored runs; ^7 returns to the base color. */
function colorRuns(text: string, base: string, colors: { mine: string; theirs: string }, honor: boolean): { text: string; color: string }[] {
  const out: { text: string; color: string }[] = [];
  let color = base;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text.charCodeAt(i + 1);
    if (c === "^" && n >= 48 && n <= 57) {
      if (cur) out.push({ text: cur, color });
      cur = "";
      if (honor) {
        const code = n - 48;
        color = code === 7 ? base : code === 8 ? colors.mine : code === 9 ? colors.theirs : CODE_COLORS[code];
      }
      i++;
      continue;
    }
    cur += c;
  }
  if (cur) out.push({ text: cur, color });
  return out;
}

export interface LineContext {
  style: Style;
  assets: Assets;
  /** Team of the player the colors are relative to, at the time of the line. */
  viewTeam: (entry: KillfeedEntry) => number;
  focusClient: number;
}

/** The pieces of a line (CL_DeathMessagePrint): "^c<attacker>^7 <icon> ^c<victim>". */
export function linePieces(entry: KillfeedEntry, ctx: LineContext): Piece[] {
  const s = ctx.style;
  const view = ctx.viewTeam(entry);
  const teamColors =
    s.colorMode === "custom"
      ? { mine: s.friendly, theirs: s.enemy }
      : view === TEAM_AXIS
        ? { mine: s.axis, theirs: s.allies }
        : { mine: s.allies, theirs: s.axis };
  if (entry.type === "message") return colorRuns(entry.text, s.neutral, teamColors, true);

  const nameColor = (p: { client: number; team: number }) => {
    if (s.highlightFocus && p.client === ctx.focusClient) return s.focusColor;
    // CG_DrawScoreboard_GetTeamColorIndex: ^8 same team as the viewer, ^9 other team, ^7 without teams.
    const teams = (t: number) => t === TEAM_AXIS || t === TEAM_ALLIES;
    if (!teams(p.team) || !teams(view)) return s.neutral;
    return p.team === view ? teamColors.mine : teamColors.theirs;
  };
  const pieces: Piece[] = [];
  if (entry.attacker) {
    pieces.push(...colorRuns(entry.attacker.name, nameColor(entry.attacker), teamColors, s.nameColors));
    pieces.push({ text: " ", color: s.neutral });
  }
  // CG_Obituary icon box in font heights: 1.4 square, 2.8 x 1.4 (2:1) or 2.8 x 0.7 (4:1); special deaths are square.
  const name = killIconName(entry, ctx.assets);
  const ratio = entry.death ? "1:1" : (ctx.assets.icons[name]?.ratio ?? "1:1");
  const [w, h] = ratio === "4:1" ? [2.8, 0.7] : ratio === "2:1" ? [2.8, 1.4] : [1.4, 1.4];
  // Only weapon icons are mirrored; means-of-death icons never are.
  pieces.push({ icon: name, w, h, flip: !entry.death && (ctx.assets.icons[name]?.flip ?? false) });
  pieces.push({ text: " ", color: s.neutral });
  pieces.push(...colorRuns(entry.victim.name, nameColor(entry.victim), teamColors, s.nameColors));
  return pieces;
}

/** Icon size in font pixels, as encoded by CL_DeathMessageIconDimension and decoded by RB_DrawHudIcon. */
function iconPixels(size: number, pixelHeight: number): number {
  const code = Math.max(16, Math.min(127, Math.round(size * 32))) + 16;
  return Math.floor((pixelHeight * (code - 16) + 16) / 32);
}

export interface RenderedLine {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Canvas pixel of the line's pen origin (left edge, baseline). */
  originX: number;
  originY: number;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

/**
 * Draw one line at output resolution into its own canvas (cached by the caller). Text uses the
 * game's font atlas, tinted per color run, with a black drop shadow; icons are drawn without one.
 */
export function renderLine(pieces: Piece[], ctx: LineContext, outputHeight: number): RenderedLine {
  const s = ctx.style;
  const font = pickFont(ctx.assets, s, outputHeight);
  const virtualToReal = outputHeight / 480;
  const charHeight = Math.round(s.textScale * 48);
  const ph = font?.pixelHeight ?? 16;
  // R_NormalizedTextScale(font, charHeight / 48) then ScrPlace_ApplyRect.
  const scale = (charHeight / ph) * virtualToReal;

  type Placed = { x: number; piece: Piece; glyphs?: { g: Glyph; x: number }[]; iw?: number; ih?: number };
  const placed: Placed[] = [];
  let pen = 0;
  for (const p of pieces) {
    if ("icon" in p) {
      const iw = iconPixels(p.w, ph) * scale * s.iconScale;
      const ih = iconPixels(p.h, ph) * scale * s.iconScale;
      placed.push({ x: pen, piece: p, iw, ih });
      pen += iw;
    } else {
      const glyphs: { g: Glyph; x: number }[] = [];
      const start = pen;
      for (const ch of p.text) {
        const g = font?.glyphs.get(ch.codePointAt(0)!) ?? font?.glyphs.get(63);
        if (!g) continue;
        glyphs.push({ g, x: pen });
        pen += g.dx * scale;
      }
      placed.push({ x: start, piece: p, glyphs });
    }
  }

  const lineH = ph * scale;
  const maxIconH = Math.max(lineH, ...placed.map((p) => p.ih ?? 0));
  const pad = Math.ceil(Math.max(4, s.shadowOffset + 2));
  const top = Math.ceil(Math.max(lineH * 1.25, (lineH + maxIconH) / 2)) + pad;
  const width = Math.ceil(pen) + pad * 2 + s.shadowOffset;
  const height = top + Math.ceil(lineH * 0.5) + pad + s.shadowOffset;
  const canvas = makeCanvas(width, height);
  const g = canvas.getContext("2d") as Ctx2D;
  const ox = pad;
  const oy = top;

  const atlas = ctx.assets.atlas;
  const [aw, ah] = ctx.assets.atlasSize;
  const drawGlyphs = (target: Ctx2D, list: { g: Glyph; x: number }[], dx: number, dy: number) => {
    if (!atlas) return;
    for (const { g: gl, x } of list) {
      const sx = gl.s0 * aw;
      const sy = gl.t0 * ah;
      const sw = (gl.s1 - gl.s0) * aw;
      const sh = (gl.t1 - gl.t0) * ah;
      if (sw <= 0 || sh <= 0) continue;
      target.drawImage(atlas, sx, sy, sw, sh, ox + x + gl.x0 * scale + dx, oy + gl.y0 * scale + dy, gl.w * scale, gl.h * scale);
    }
  };
  // Tint: draw white glyphs to a scratch canvas, then keep only their alpha in the run color.
  const scratch = makeCanvas(width, height);
  const sg = scratch.getContext("2d") as Ctx2D;
  const tinted = (list: { g: Glyph; x: number }[], color: string, dx: number, dy: number) => {
    sg.globalCompositeOperation = "source-over";
    sg.clearRect(0, 0, width, height);
    drawGlyphs(sg, list, dx, dy);
    sg.globalCompositeOperation = "source-in";
    sg.fillStyle = color;
    sg.fillRect(0, 0, width, height);
    g.drawImage(scratch, 0, 0);
  };

  const textRuns = placed.filter((p) => p.glyphs?.length);
  if (atlas) {
    if (s.shadow) tinted(textRuns.flatMap((p) => p.glyphs!), "#000000", s.shadowOffset, s.shadowOffset);
    for (const p of textRuns) tinted(p.glyphs!, (p.piece as { color: string }).color, 0, 0);
  } else {
    // No game font: a plain fallback so the tool still works without extracted assets.
    g.font = `${Math.round(lineH * 0.8)}px sans-serif`;
    g.textBaseline = "alphabetic";
    for (const p of placed) {
      if (!("text" in p.piece)) continue;
      if (s.shadow) {
        g.fillStyle = "#000";
        g.fillText(p.piece.text, ox + p.x + s.shadowOffset, oy + s.shadowOffset);
      }
      g.fillStyle = p.piece.color;
      g.fillText(p.piece.text, ox + p.x, oy);
    }
  }
  for (const p of placed) {
    if (!("icon" in p.piece)) continue;
    const icon = ctx.assets.icons[p.piece.icon];
    // RB_DrawHudIcon: centered on the line's glyph box.
    const iy = oy - (lineH + p.ih!) / 2;
    if (icon && p.piece.flip) {
      g.save();
      g.translate(ox + p.x + p.iw!, iy);
      g.scale(-1, 1);
      g.drawImage(icon.image, 0, 0, p.iw!, p.ih!);
      g.restore();
    } else if (icon) g.drawImage(icon.image, ox + p.x, iy, p.iw!, p.ih!);
    else {
      g.fillStyle = "rgba(255,255,255,0.6)";
      g.fillRect(ox + p.x, iy, p.iw!, p.ih!);
    }
  }
  return { canvas, originX: ox, originY: oy };
}

/** Where a line's pen origin lands on the output: x from the left edge, baseline from the bottom. */
export function lineOrigin(s: Style, placedY: number, width: number, height: number): [number, number] {
  const v = height / 480;
  return [s.x * v, height + placedY * v];
}
