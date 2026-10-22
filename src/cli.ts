#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeDemo } from "./demo/decoder.ts";
import { extractKillfeed } from "./demo/killfeed.ts";
import { extractKillfeedAssets } from "./extract/assets.ts";
import { loadLocalizedStrings } from "./extract/strings.ts";

const root = join(dirname(new URL(import.meta.url).pathname), "..");

function usage(): never {
  console.error(
    [
      "cod4-killfeed — CoD4 killfeed renderer tools (the page itself is dist/cod4-killfeed.html)",
      "",
      "  node src/cli.ts assets <CoD4 dir> [--out assets]   Extract kill icons, HUD font and UI strings",
      "  node src/cli.ts json <demo.dm_1> [--out f.json]    Killfeed as JSON (obituaries + notifications)",
      "        [--game <CoD4 dir>]                          ...with notification texts from the game's strings",
    ].join("\n"),
  );
  process.exit(1);
}

function flagsOf(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) flags.set(args[i].slice(2), args[++i] ?? "");
  return flags;
}

const [cmd, target, ...rest] = process.argv.slice(2);
if (!target) usage();
const flags = flagsOf(rest);
if (cmd === "assets") {
  const out = flags.get("out") || join(root, "assets");
  const r = extractKillfeedAssets(target, out);
  console.log(`Wrote ${out}: ${r.icons.length} icons for ${r.weapons} weapons + ${r.spare.length} spare icons, fonts ${r.fonts.join(", ") || "(none)"}, ${r.strings} UI strings.`);
  if (r.missing.length) console.log(`Not found: ${r.missing.join(", ")}`);
  console.log("Rebuild the page with: npm run build");
} else if (cmd === "json") {
  const game = flags.get("game");
  const feed = extractKillfeed(decodeDemo(readFileSync(target)), game ? loadLocalizedStrings(game) : new Map());
  const json = JSON.stringify(feed, null, 2) + "\n";
  const out = flags.get("out");
  if (out) {
    writeFileSync(out, json);
    const obits = feed.entries.filter((e) => e.type === "obituary");
    console.error(`Wrote ${out}: ${obits.length} obituaries (${obits.filter((e) => e.killcam).length} in killcams), ${feed.entries.length - obits.length} notifications.`);
  } else process.stdout.write(json);
} else usage();
