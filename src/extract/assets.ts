import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unwrapFastFile } from "./fastfile.ts";
import { decodeIwi } from "./iwi.ts";
import { listIwd, readIwdEntry } from "./iwd.ts";
import { encodePng } from "./png.ts";
import { loadLocalizedStrings } from "./strings.ts";

/**
 * Extract what the killfeed tool needs from a local CoD4 install: kill icons,
 * the HUD font (atlas + glyph metrics) and the English UI strings. Everything
 * is written as plain PNG/JSON so it can be edited or replaced by hand.
 */

/** Ratio of a kill icon's box (width:height), as the game's killIconRatio. */
export type IconRatio = "1:1" | "2:1" | "4:1";

export interface IconManifest {
  version: 1;
  /** Icon name -> image file in this folder, the shape it is drawn at, and whether it is mirrored (flipKillIcon). */
  icons: Record<string, { file: string; ratio: IconRatio; flip?: boolean }>;
  /**
   * Weapon (internal name without "_mp") -> icon name. Lookup also tries the name with
   * trailing "_<attachment>" parts removed, then "gl" for "gl_*" launchers, then "default".
   */
  weapons: Record<string, string>;
  /** Special means of death (shown instead of the weapon) -> icon name. */
  deaths: Record<string, string>;
}

export interface FontFile {
  atlas: string;
  width: number;
  height: number;
  fonts: Record<string, { pixelHeight: number; glyphs: number[][] }>;
}

/** A weapon's kill icon, from its weapon file (weapons/mp/<name> in the iwd files). */
export interface WeaponIcon {
  /** Weapon name without "_mp", as the killfeed entries and the manifest's weapon table use it. */
  weapon: string;
  /** killIcon material, or "" when the weapon has none (the game then shows the "died" icon). */
  material: string;
  ratio: IconRatio;
  flip: boolean;
}

/** Parse a weapon file ("WEAPONFILE\\key\\value\\..."): kill icon material, killIconRatio and flipKillIcon. */
export function parseWeaponFile(name: string, text: string): WeaponIcon | null {
  if (!text.startsWith("WEAPONFILE\\")) return null;
  const parts = text.split("\\");
  const kv = new Map<string, string>();
  for (let i = 1; i + 1 < parts.length; i += 2) kv.set(parts[i], parts[i + 1]);
  const ratio = kv.get("killIconRatio");
  return {
    weapon: name.replace(/_mp$/, ""),
    material: kv.get("killIcon") ?? "",
    ratio: ratio === "2:1" || ratio === "4:1" ? ratio : "1:1",
    flip: kv.get("flipKillIcon") === "1",
  };
}

/** Means of death the game shows instead of the weapon (CG_Obituary), with their materials and icon names. */
const DEATH_ICONS: Record<string, { material: string; icon: string }> = {
  died: { material: "killicondied", icon: "skull" },
  suicide: { material: "killiconsuicide", icon: "skull" },
  melee: { material: "killiconmelee", icon: "knife" },
  headshot: { material: "killiconheadshot", icon: "headshot" },
  crush: { material: "killiconcrush", icon: "crush" },
  falling: { material: "killiconfalling", icon: "falling" },
  impact: { material: "killiconimpact", icon: "impact" },
};

/** Icon names for weapons whose own names make a poor one; other icons are named after their shortest weapon. */
const ICON_NAMES: Record<string, string> = {
  artillery: "artillery",
  cobra_20mm: "helicopter",
  saw_bipod_stand: "saw_bipod",
};

/** Kill icon materials that are not weapon icons (the radar and airstrike selectors), left out of the set. */
const isKillIcon = (material: string) => /^(hud_|death_)/i.test(material);

/**
 * Build the icon set and manifest from the weapon files: one icon per (image, ratio, mirroring) the game
 * draws, every weapon mapped to its icon. `imageOf` resolves a material to its image (undefined when missing).
 */
export function buildIconManifest(
  weapons: WeaponIcon[],
  imageOf: (material: string) => string | undefined,
): { manifest: IconManifest; images: Record<string, string>; missing: string[] } {
  const manifest: IconManifest = { version: 1, icons: {}, weapons: {}, deaths: {} };
  const images: Record<string, string> = {};
  const missing = new Set<string>();
  const byKey = new Map<string, string>();
  const add = (key: string, image: string, ratio: IconRatio, flip: boolean, names: string[]) => {
    let name = names.find((n) => !manifest.icons[n]) ?? `${names[0]}_${ratio.replace(":", "x")}`;
    for (let i = 2; manifest.icons[name]; i++) name = `${names[0]}_${i}`;
    manifest.icons[name] = { file: `${name}.png`, ratio, ...(flip ? { flip: true } : {}) };
    images[name] = image;
    byKey.set(key, name);
  };

  for (const [death, { material, icon }] of Object.entries(DEATH_ICONS)) {
    const image = imageOf(material);
    if (!image) {
      missing.add(material);
      continue;
    }
    const key = `${image}|1:1|`;
    if (!byKey.has(key)) add(key, image, "1:1", false, [icon]);
    manifest.deaths[death] = byKey.get(key)!;
  }
  const died = manifest.deaths.died ?? "skull";

  // Group weapons by what the game draws; bigger groups pick their name first.
  const groups = new Map<string, { image: string; ratio: IconRatio; flip: boolean; weapons: string[] }>();
  for (const w of weapons) {
    manifest.weapons[w.weapon] = died;
    if (!w.material || !isKillIcon(w.material)) continue;
    const image = imageOf(w.material);
    if (!image) {
      missing.add(w.material);
      continue;
    }
    const key = `${image}|${w.ratio}|${w.flip ? 1 : ""}`;
    if (!groups.has(key)) groups.set(key, { image, ratio: w.ratio, flip: w.flip, weapons: [] });
    groups.get(key)!.weapons.push(w.weapon);
  }
  const shortest = (names: string[]) => [...names].sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const [key, g] of [...groups].sort((a, b) => b[1].weapons.length - a[1].weapons.length || a[0].localeCompare(b[0]))) {
    if (!byKey.has(key)) add(key, g.image, g.ratio, g.flip, [...g.weapons.flatMap((w) => ICON_NAMES[w] ?? []), ...shortest(g.weapons)]);
    for (const w of g.weapons) manifest.weapons[w] = byKey.get(key)!;
  }
  manifest.weapons.default = died;
  manifest.weapons = Object.fromEntries(Object.entries(manifest.weapons).sort(([a], [b]) => a.localeCompare(b)));
  return { manifest, images, missing: [...missing] };
}

/**
 * Other kill-icon style images in the game files (weapon silhouettes and death icons), extracted as spare
 * icons for custom weapon mappings. Everything named hud_* or death_* except HUD furniture.
 */
const isSpareIcon = (image: string) =>
  /^(hud_|death_)/.test(image) &&
  !/^hud_(arrow|bullets|checkbox|cobra|colors|damagefeedback|dpad|flashbangicon|grenade|hardcore|health|javelin_|message|mpflag|nvg|obituaries|offscreen|parabolic|rank|rpg_dpad|server|show|status|teamcaret|temperature|util|weaponmode|xpticker)/.test(image);

/** Shape of a kill icon box for an image's aspect (128x32 -> 4:1, 128x64 and 64x32 -> 2:1, square -> 1:1). */
export function ratioForImage(width: number, height: number): IconRatio {
  const aspect = width / height;
  return aspect >= 3 ? "4:1" : aspect >= 1.5 ? "2:1" : "1:1";
}

/** Index the game's iwd files: images and multiplayer weapon files (later archives override earlier ones, like the game). */
function indexIwds(gameDir: string) {
  const main = join(gameDir, "main");
  const iwds = readdirSync(main)
    .filter((f) => /\.iwd$/i.test(f))
    .sort();
  type Source = { iwd: string; entry: ReturnType<typeof listIwd>[number] };
  const images = new Map<string, Source>();
  const weapons = new Map<string, Source>();
  for (const f of iwds) {
    const path = join(main, f);
    for (const entry of listIwd(readFileSync(path))) {
      const m = /^images\/(.+)\.iwi$/i.exec(entry.name);
      if (m) images.set(m[1].toLowerCase(), { iwd: path, entry });
      const w = /^weapons\/mp\/([^/]+)$/i.exec(entry.name);
      if (w) weapons.set(w[1].toLowerCase(), { iwd: path, entry });
    }
  }
  return { images, weapons };
}

/**
 * Materials whose image is shared with an earlier material (stored as a pointer into the zone, which this
 * reader doesn't resolve): the image the game draws for them.
 */
const SHARED_IMAGES: Record<string, string> = {
  killiconsuicide: "death_suicide",
};

/**
 * Material -> image name, read from the 2D materials in the game's zones. In the zone a material's name
 * string (after a -1 pointer) is followed by its texture table: { nameHash, nameStart, nameEnd, samplerState,
 * semantic, image }, and an inline GfxImage has its name pointer at +32 with the name after the struct.
 */
function materialImages(zones: Buffer[], materials: Iterable<string>, hasImage: (name: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  for (const material of materials) {
    for (const zone of zones) {
      const at = zone.indexOf(Buffer.from(`\xff${material}\x00`, "latin1"));
      if (at < 0) continue;
      const textureDef = at + material.length + 2;
      let image: string | undefined;
      if (zone.readInt32LE(textureDef + 8) !== -1) image = SHARED_IMAGES[material];
      else {
        const gfxImage = textureDef + 12;
        // A name pointer other than -1 reuses an existing string: the material's own name.
        if (zone.readInt32LE(gfxImage + 32) === -1) image = zone.toString("latin1", gfxImage + 36, zone.indexOf(0, gfxImage + 36));
        else image = material;
      }
      if (image && hasImage(image)) out.set(material, image.toLowerCase());
      break;
    }
  }
  return out;
}

/** Font_s tables in a zone: 24-byte header (name ptr, pixelHeight, glyphCount, material, glow, glyphs) then the name. */
export function parseFonts(zone: Buffer): FontFile["fonts"] {
  const text = zone.toString("latin1");
  const fonts: FontFile["fonts"] = {};
  for (const m of text.matchAll(/fonts\/([A-Za-z]+)\x00/g)) {
    const header = m.index! - 24;
    if (header < 0 || zone.readInt32LE(header) !== -1 || zone.readInt32LE(header + 20) !== -1) continue;
    const pixelHeight = zone.readInt32LE(header + 4);
    const count = zone.readInt32LE(header + 8);
    let p = m.index! + m[0].length;
    // Inline materials would sit between the name and the glyphs; the game fonts reference an earlier one.
    if (zone.readUInt16LE(p) !== 32) continue;
    const glyphs: number[][] = [];
    for (let i = 0; i < count; i++, p += 24) {
      glyphs.push([
        zone.readUInt16LE(p),
        zone.readInt8(p + 2),
        zone.readInt8(p + 3),
        zone.readUInt8(p + 4),
        zone.readUInt8(p + 5),
        zone.readUInt8(p + 6),
        ...[0, 1, 2, 3].map((k) => Math.round(zone.readFloatLE(p + 8 + 4 * k) * 1e6) / 1e6),
      ]);
    }
    fonts[m[1]] = { pixelHeight, glyphs };
  }
  return fonts;
}

export interface ExtractResult {
  icons: string[];
  /** Kill-icon images no multiplayer weapon uses, extracted for custom mappings. */
  spare: string[];
  weapons: number;
  missing: string[];
  fonts: string[];
  strings: number;
}

export function extractKillfeedAssets(gameDir: string, outDir: string, language = "english"): ExtractResult {
  if (!existsSync(join(gameDir, "main"))) throw new Error(`No "main" folder in ${gameDir}: point this at the CoD4 install folder.`);
  const { images, weapons } = indexIwds(gameDir);
  const archives = new Map<string, Buffer>();
  const read = (src: { iwd: string; entry: ReturnType<typeof listIwd>[number] }) => {
    let iwd = archives.get(src.iwd);
    if (!iwd) archives.set(src.iwd, (iwd = readFileSync(src.iwd)));
    return readIwdEntry(iwd, src.entry);
  };
  const loadImage = (name: string) => {
    const src = images.get(name.toLowerCase());
    return src ? decodeIwi(read(src)) : null;
  };

  const weaponIcons: WeaponIcon[] = [];
  for (const [name, src] of weapons) {
    const w = parseWeaponFile(name, read(src).toString("latin1"));
    if (w) weaponIcons.push(w);
  }
  const zones = ["code_post_gfx_mp", "common_mp"]
    .map((z) => join(gameDir, "zone", language, `${z}.ff`))
    .filter((f) => existsSync(f))
    .map((f) => unwrapFastFile(readFileSync(f)).zone);
  const wanted = new Set([...weaponIcons.map((w) => w.material).filter(isKillIcon), ...Object.values(DEATH_ICONS).map((d) => d.material)]);
  const matImages = materialImages(zones, wanted, (n) => images.has(n.toLowerCase()));
  const { manifest, images: iconImages, missing } = buildIconManifest(weaponIcons, (m) => matImages.get(m));

  const iconDir = join(outDir, "icons");
  mkdirSync(iconDir, { recursive: true });
  const done: string[] = [];
  const spare: string[] = [];
  for (const [name, image] of Object.entries(iconImages)) {
    const img = loadImage(image);
    if (!img) {
      missing.push(`${name} (${image})`);
      delete manifest.icons[name];
      continue;
    }
    writeFileSync(join(iconDir, `${name}.png`), encodePng(img.width, img.height, img.rgba));
    done.push(name);
  }
  // Spare icons: shaped by their image and, like the game's gun icons, mirrored unless explosive or a death icon.
  const used = new Set(Object.values(iconImages));
  for (const image of [...images.keys()].filter((i) => isSpareIcon(i) && !used.has(i)).sort()) {
    const img = loadImage(image);
    if (!img) continue;
    let name = image.replace(/^hud_/, "");
    if (manifest.icons[name]) name = image;
    const flip = !/^death_|40mm|artillery|suitcase|c4|claymore/.test(image);
    manifest.icons[name] = { file: `${name}.png`, ratio: ratioForImage(img.width, img.height), ...(flip ? { flip: true } : {}) };
    writeFileSync(join(iconDir, `${name}.png`), encodePng(img.width, img.height, img.rgba));
    spare.push(name);
  }
  writeFileSync(join(iconDir, "icons.json"), JSON.stringify(manifest, null, 2) + "\n");

  const fontDir = join(outDir, "font");
  mkdirSync(fontDir, { recursive: true });
  const atlas = loadImage("gamefonts_pc");
  const ff = join(gameDir, "zone", language, "localized_code_post_gfx_mp.ff");
  let fontNames: string[] = [];
  if (atlas && existsSync(ff)) {
    const fonts = parseFonts(unwrapFastFile(readFileSync(ff)).zone);
    writeFileSync(join(fontDir, "gamefonts_pc.png"), encodePng(atlas.width, atlas.height, atlas.rgba));
    const file: FontFile = { atlas: "gamefonts_pc.png", width: atlas.width, height: atlas.height, fonts };
    writeFileSync(join(fontDir, "fonts.json"), JSON.stringify(file) + "\n");
    fontNames = Object.keys(fonts);
  }

  const strings = loadLocalizedStrings(gameDir, language);
  writeFileSync(join(outDir, "strings.json"), JSON.stringify(Object.fromEntries(strings)) + "\n");
  return { icons: done, spare, weapons: weaponIcons.length, missing, fonts: fontNames, strings: strings.size };
}
