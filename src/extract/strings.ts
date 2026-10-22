import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unwrapFastFile } from "./fastfile.ts";

/** Strings whose zone entry points elsewhere for its text (not matched by the scan below). */
const LOCALIZED_FALLBACK: Record<string, string> = {
  GAME_CALLEDAVOTE: "&&1 called a vote.",
  GAME_VOTECAST: "Vote cast.",
  GAME_VOTEPASSED: "Vote passed.",
  GAME_VOTEFAILED: "Vote failed.",
};

/** Load the game's UI strings (key -> text) from its localized FastFiles. */
export function loadLocalizedStrings(gameDir: string, language = "english"): Map<string, string> {
  const out = new Map<string, string>(Object.entries(LOCALIZED_FALLBACK));
  for (const zone of ["localized_code_post_gfx_mp", "localized_common_mp"]) {
    const ff = join(gameDir, "zone", language, `${zone}.ff`);
    if (!existsSync(ff)) continue;
    const text = unwrapFastFile(readFileSync(ff)).zone.toString("latin1");
    // LocalizeEntry in the zone: 8 bytes of 0xff (pointers), "value\0", "KEY\0".
    for (const m of text.matchAll(/\xff{8}([^\x00\xff]*)\x00([A-Z][A-Z0-9_]+)\x00/g)) {
      if (!out.has(m[2]) || LOCALIZED_FALLBACK[m[2]]) out.set(m[2], m[1]);
    }
  }
  return out;
}
