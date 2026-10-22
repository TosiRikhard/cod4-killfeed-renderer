import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { decodeIwi } from "../src/extract/iwi.ts";
import { encodePng } from "../src/extract/png.ts";
import { killIconName, type KillfeedEntry } from "../src/demo/killfeed.ts";
import { buildIconManifest, parseWeaponFile, ratioForImage } from "../src/extract/assets.ts";
import { DEFAULT_STYLE, placeLines, type FeedLine } from "../src/app/render.ts";
import { ZipWriter } from "../src/app/zip.ts";

function iwi(format: number, width: number, height: number, data: number[]): Buffer {
  const h = Buffer.alloc(28);
  h.write("IWi", 0, "latin1");
  h[3] = 6;
  h[4] = format;
  h.writeUInt16LE(width, 6);
  h.writeUInt16LE(height, 8);
  h.writeUInt16LE(1, 10);
  return Buffer.concat([h, Buffer.from(data)]);
}

test("decodeIwi: DXT1 block with two endpoint colors", () => {
  // c0 = pure red (0xf800), c1 = pure blue (0x001f); indices: row 0 all c0, row 1 all c1, rows 2-3 2/3-1/3 mixes.
  const img = decodeIwi(iwi(11, 4, 4, [0x00, 0xf8, 0x1f, 0x00, 0b00000000, 0b01010101, 0b10101010, 0b11111111]));
  assert.equal(img.width, 4);
  assert.deepEqual([...img.rgba.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...img.rgba.subarray(16, 20)], [0, 0, 255, 255]);
  assert.deepEqual([...img.rgba.subarray(32, 36)], [170, 0, 85, 255]);
});

test("decodeIwi: DXT5 alpha interpolation and indices", () => {
  // alpha0 = 255, alpha1 = 0, index 0 for pixel 0, index 1 for pixel 1, index 2 (6/7*255 + 1/7*0) for pixel 2.
  const alphaBits = 0 | (1 << 3) | (2 << 6);
  const alpha = [255, 0, alphaBits & 0xff, (alphaBits >> 8) & 0xff, 0, 0, 0, 0];
  const color = [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0];
  const img = decodeIwi(iwi(13, 4, 4, [...alpha, ...color]));
  assert.equal(img.rgba[3], 255);
  assert.equal(img.rgba[7], 0);
  assert.equal(img.rgba[11], 219);
  assert.deepEqual([...img.rgba.subarray(0, 3)], [255, 255, 255]);
});

test("decodeIwi rejects other files", () => {
  assert.throws(() => decodeIwi(Buffer.from("not an image at all, no")), /Not an IWI/);
});

test("encodePng writes a valid RGBA PNG", () => {
  const rgba = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 128]);
  const png = encodePng(2, 1, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 2);
  assert.equal(png.readUInt32BE(20), 1);
  const idatAt = png.indexOf("IDAT");
  const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + png.readUInt32BE(idatAt - 4)));
  assert.deepEqual([...raw], [0, ...rgba]);
});

test("ratioForImage matches the game's kill icon shapes", () => {
  assert.equal(ratioForImage(128, 32), "4:1");
  assert.equal(ratioForImage(128, 64), "2:1");
  assert.equal(ratioForImage(64, 32), "2:1");
  assert.equal(ratioForImage(64, 64), "1:1");
});

test("parseWeaponFile reads the kill icon, its ratio and mirroring", () => {
  const w = parseWeaponFile("m16_gl_mp", "WEAPONFILE\\displayName\\WEAPON_M16\\killIcon\\hud_icon_m16a4_grenade\\killIconRatio\\4:1\\flipKillIcon\\1");
  assert.deepEqual(w, { weapon: "m16_gl", material: "hud_icon_m16a4_grenade", ratio: "4:1", flip: true });
  assert.deepEqual(parseWeaponFile("flash_grenade_mp", "WEAPONFILE\\killIconRatio\\4:1"), { weapon: "flash_grenade", material: "", ratio: "4:1", flip: false });
  assert.equal(parseWeaponFile("x", "not a weapon file"), null);
});

test("buildIconManifest: one icon per drawn shape, every weapon mapped", () => {
  const w = (weapon: string, material: string, ratio: "1:1" | "2:1" | "4:1", flip: boolean) => ({ weapon, material, ratio, flip });
  const materials: Record<string, string> = {
    killicondied: "death_suicide",
    killiconsuicide: "death_suicide",
    killiconmelee: "death_knife",
    hud_icon_m4carbine: "hud_m4carbine",
    death_helicopter: "death_heli",
  };
  const { manifest, images } = buildIconManifest(
    [
      w("m4", "hud_icon_m4carbine", "2:1", true),
      w("m4_silencer", "hud_icon_m4carbine", "2:1", true),
      w("cobra_20mm", "death_helicopter", "4:1", true),
      w("hind_ffar", "death_helicopter", "4:1", true),
      w("helicopter", "death_helicopter", "1:1", false),
      w("flash_grenade", "", "1:1", false),
      w("radar", "compass_objpoint_satallite", "1:1", false),
    ],
    (m) => materials[m],
  );
  assert.deepEqual(manifest.deaths, { died: "skull", suicide: "skull", melee: "knife" });
  assert.equal(images.skull, "death_suicide");
  assert.equal(manifest.weapons.m4_silencer, "m4");
  assert.deepEqual(manifest.icons.m4, { file: "m4.png", ratio: "2:1", flip: true });
  // The same image drawn two ways is two icons; the bigger group keeps the plain name.
  assert.equal(manifest.weapons.cobra_20mm, "helicopter");
  assert.equal(manifest.weapons.helicopter, "helicopter_1x1");
  assert.deepEqual(manifest.icons.helicopter_1x1, { file: "helicopter_1x1.png", ratio: "1:1" });
  // No kill icon (or a non-icon material): the "died" skull, like the game.
  assert.equal(manifest.weapons.flash_grenade, "skull");
  assert.equal(manifest.weapons.radar, "skull");
  assert.equal(manifest.weapons.default, "skull");
});

test("killIconName: exact weapons, attachments, launchers and special deaths", () => {
  const m = { weapons: { m4: "m4", m16_gl: "m16", gl: "gl", default: "skull" }, deaths: { died: "skull", melee: "knife" } };
  const icon = (weapon: string, death = "") => killIconName({ weapon, death }, m);
  assert.equal(icon("m16_gl_mp"), "m16");
  assert.equal(icon("m4_silencer_mp"), "m4");
  assert.equal(icon("gl_g36c_mp"), "gl");
  assert.equal(icon("modded_gun_mp"), "skull");
  assert.equal(icon("", "melee"), "knife");
  assert.equal(icon("", "headshot"), "skull");
});

function line(start: number, msgTime = 5000): FeedLine {
  const entry = { type: "message", time: start, text: "x", key: "", killcam: false, viewClient: 0, viewTeam: 0 } as KillfeedEntry;
  return { entry, start, end: start + msgTime };
}

test("placeLines follows the game's scroll and fades", () => {
  const s = { ...DEFAULT_STYLE };
  const charHeight = Math.round(s.textScale * 48);
  const lines = [line(0)];
  // Start of the scroll: one line below its place, invisible.
  let [p] = placeLines(lines, 0, s, []);
  assert.equal(p.y, s.y + charHeight);
  assert.equal(p.alpha, 0);
  // Halfway through scroll/fade-in (0.25 s each by default).
  [p] = placeLines(lines, 125, s, []);
  assert.equal(p.alpha, 0.5);
  // Settled.
  [p] = placeLines(lines, 1000, s, []);
  assert.equal(p.y, s.y);
  assert.equal(p.alpha, 1);
  // Fading out over the last 0.5 s, gone at the end.
  [p] = placeLines(lines, 4750, s, []);
  assert.equal(p.alpha, 0.5);
  assert.equal(placeLines(lines, 5000, s, []).length, 0);
});

test("placeLines stacks newest at the bottom and keeps only lineCount lines", () => {
  const s = { ...DEFAULT_STYLE, lineCount: 2 };
  const charHeight = Math.round(s.textScale * 48);
  const lines = [line(0), line(1000), line(2000)];
  const placed = placeLines(lines, 3000, s, []);
  assert.deepEqual(
    placed.map((p) => p.line.start),
    [2000, 1000],
  );
  assert.deepEqual(
    placed.map((p) => p.y),
    [s.y, s.y - charHeight],
  );
});

test("placeLines keep mode never fades; clearOnRound empties the window", () => {
  const keep = { ...DEFAULT_STYLE, keep: true };
  const lines = [line(0, Infinity), line(1000, Infinity)];
  assert.equal(placeLines(lines, 600000, keep, []).length, 2);
  assert.ok(placeLines(lines, 600000, keep, []).every((p) => p.alpha === 1));
  const clear = { ...keep, clearOnRound: true };
  assert.equal(placeLines(lines, 5000, clear, [500]).length, 1);
  assert.equal(placeLines(lines, 5000, clear, [3000]).length, 0);
});

test("ZipWriter produces a readable stored zip", async () => {
  const zip = new ZipWriter();
  zip.add("a.txt", new TextEncoder().encode("hello"));
  zip.add("dir/b.bin", Uint8Array.from([1, 2, 3]));
  const buf = Buffer.from(await zip.finish().arrayBuffer());
  const { listIwd, readIwdEntry } = await import("../src/extract/iwd.ts");
  const entries = listIwd(buf);
  assert.deepEqual(
    entries.map((e) => e.name),
    ["a.txt", "dir/b.bin"],
  );
  assert.equal(readIwdEntry(buf, entries[0]).toString(), "hello");
  assert.deepEqual([...readIwdEntry(buf, entries[1])], [1, 2, 3]);
});

// Runs only with a real demo (demos are never committed): TEST_DEMO=/path/to/demo.dm_1 npm test
const demoPath = process.env.TEST_DEMO;
test("extractKillfeed on a real demo: names, weapons, killcam replays flagged", { skip: demoPath ? false : "set TEST_DEMO to a .dm_1 file to run" }, async () => {
  const { readFileSync } = await import("node:fs");
  const { decodeDemo } = await import("../src/demo/decoder.ts");
  const { extractKillfeed } = await import("../src/demo/killfeed.ts");
  const feed = extractKillfeed(decodeDemo(readFileSync(demoPath!)));
  const obits = feed.entries.filter((e) => e.type === "obituary");
  assert.ok(obits.length > 0, "expected obituaries");
  assert.ok(obits.every((e) => e.victim.name.length > 0));
  assert.ok(feed.recorder >= 0 && feed.recorder < 64);
  // A killcam replays the last kill: it must not count as a new one outside the killcam.
  for (const e of obits.filter((x) => x.killcam)) assert.ok(obits.some((o) => !o.killcam && o.victim.client === e.victim.client && o.time < e.time));
});
