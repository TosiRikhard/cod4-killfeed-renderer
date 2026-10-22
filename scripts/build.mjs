#!/usr/bin/env node
// Build the killfeed page: one HTML file with the app, the decoder worker and the
// extracted game assets inlined. Usage: node scripts/build.mjs [assetsDir] [out.html]
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "src", "app");
const assetsDir = resolve(process.argv[2] ?? join(root, "assets"));
const out = resolve(process.argv[3] ?? join(root, "dist", "cod4-killfeed.html"));

const common = { bundle: true, format: "iife", platform: "browser", target: "es2022", minify: true, legalComments: "none", write: false };
const worker = await build({ ...common, entryPoints: [join(web, "worker.ts")], inject: [join(web, "buffer-shim.js")] });
const app = await build({
  ...common,
  entryPoints: [join(web, "main.ts")],
  define: { __WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text) },
});

const dataUri = (file, type) => `data:${type};base64,${readFileSync(file).toString("base64")}`;
const assets = { manifest: null, icons: {}, fonts: null, atlas: null, strings: {} };
const iconDir = join(assetsDir, "icons");
if (existsSync(join(iconDir, "icons.json"))) assets.manifest = JSON.parse(readFileSync(join(iconDir, "icons.json"), "utf8"));
if (existsSync(iconDir)) {
  for (const f of readdirSync(iconDir)) {
    const m = /^(.+)\.png$/i.exec(f);
    if (!m) continue;
    assets.icons[m[1]] = dataUri(join(iconDir, f), "image/png");
    // Icons added by hand without a manifest entry still show up (as 1:1 until set otherwise).
    if (assets.manifest && !assets.manifest.icons[m[1]]) assets.manifest.icons[m[1]] = { file: f, ratio: "1:1" };
  }
}
const fontFile = join(assetsDir, "font", "fonts.json");
if (existsSync(fontFile)) {
  assets.fonts = JSON.parse(readFileSync(fontFile, "utf8"));
  assets.atlas = dataUri(join(assetsDir, "font", assets.fonts.atlas), "image/png");
}
if (existsSync(join(assetsDir, "strings.json"))) assets.strings = JSON.parse(readFileSync(join(assetsDir, "strings.json"), "utf8"));

// "</script" inside inlined code or data would end the script element early.
const script = (code) => `<script>${code.replace(/<\/script/gi, "<\\/script")}</script>`;
const html = readFileSync(join(web, "index.html"), "utf8")
  .replace("<!--ASSETS-->", () => script(`window.__KILLFEED_ASSETS__=${JSON.stringify(assets)};`))
  .replace("<!--APP-->", () => script(app.outputFiles[0].text));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`Wrote ${out} (${kb(html.length)}): ${Object.keys(assets.icons).length} icons, ${assets.fonts ? Object.keys(assets.fonts.fonts).length : 0} fonts, ${Object.keys(assets.strings).length} strings.`);
if (!assets.fonts) console.log(`No game assets in ${assetsDir}: run "node src/cli.ts assets <CoD4 folder>" first for the real font and icons.`);
