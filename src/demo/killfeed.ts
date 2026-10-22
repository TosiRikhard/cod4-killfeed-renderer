import type { ClientChange, DecodeResult } from "./decoder.ts";
import { parseInfoString } from "./meta.ts";
import { commandArg, renderMessage } from "./text.ts";

/**
 * The killfeed as the game showed it: obituaries (CG_Obituary) and the game
 * notifications that share their on-screen window ("gamenotify obituary").
 * No Node dependencies, so the browser tool can use it.
 */

export const TEAM_FREE = 0;
export const TEAM_AXIS = 1;
export const TEAM_ALLIES = 2;
export const TEAM_SPECTATOR = 3;

export interface KillfeedPlayer {
  client: number;
  /** Name as sent by the server, color codes included. */
  name: string;
  team: number;
}

interface EntryBase {
  /** Demo playback time in ms (see DecodedSnapshot.demoTime). */
  time: number;
  /** A killcam was playing; the game prints nothing then. */
  killcam: boolean;
  /** Client whose view was shown, and their team: decides friendly/enemy colors. */
  viewClient: number;
  viewTeam: number;
}

export interface ObituaryEntry extends EntryBase {
  type: "obituary";
  /** null for world/suicide kills, which show only the icon and the victim. */
  attacker: KillfeedPlayer | null;
  victim: KillfeedPlayer;
  /** Internal weapon name as the server lists it, e.g. "ak47_mp" ("" when none). */
  weapon: string;
  /** Means-of-death icon shown instead of the weapon ("headshot", "melee", ...), or "". */
  death: string;
  /** Means of death number when the server sent one instead of a weapon (eventParm 128+n), else -1. */
  mod: number;
  kind: "kill" | "teamkill" | "suicide" | "world";
}

export interface MessageEntry extends EntryBase {
  type: "message";
  /** Rendered text with color codes. */
  text: string;
  key: string;
}

export type KillfeedEntry = ObituaryEntry | MessageEntry;

export interface Killfeed {
  durationMs: number;
  /** Client number of the player who recorded the demo. */
  recorder: number;
  maps: { time: number; map: string; gametype: string }[];
  /** Times at which a round (map_restart) or map started. */
  rounds: number[];
  /** Team colors from the server (g_TeamColor_Allies/Axis) when it sent them, else the game defaults. */
  teamColors: { allies: [number, number, number]; axis: [number, number, number] };
  entries: KillfeedEntry[];
}

const ET_OBITUARY = 83; // ET_EVENTS (17) + EV_OBITUARY
const MAX_CLIENTS = 64;
const CS_WEAPONS = 2258; // space-separated weapon list; obituary weapon N is entry N-1
/** Means of death with their own icon (CG_Obituary); others show the "died" skull. */
const DEATHS: Record<number, string> = { 7: "melee", 8: "headshot", 9: "crush", 11: "falling", 12: "suicide", 13: "died", 15: "impact" };
export const DEFAULT_TEAM_COLORS: Killfeed["teamColors"] = { allies: [0.6, 0.64, 0.69], axis: [0.65, 0.57, 0.41] };

/** Name and team of each client over time, for lookups at a given demo time. */
export class ClientTimeline {
  private byClient = new Map<number, ClientChange[]>();
  constructor(changes: ClientChange[]) {
    for (const c of changes) {
      let list = this.byClient.get(c.client);
      if (!list) this.byClient.set(c.client, (list = []));
      list.push(c);
    }
  }
  at(client: number, time: number): ClientChange | undefined {
    const list = this.byClient.get(client);
    if (!list) return undefined;
    let best = list[0];
    for (const c of list) if (c.time <= time) best = c;
    return best;
  }
}

function parseColor(s: string | undefined): [number, number, number] | null {
  const v = (s ?? "").trim().split(/\s+/).map(Number);
  return v.length >= 3 && v.slice(0, 3).every(Number.isFinite) ? [v[0], v[1], v[2]] : null;
}

export function extractKillfeed(d: DecodeResult, loc: Map<string, string> = new Map()): Killfeed {
  const clients = new ClientTimeline(d.clientChanges);
  const snaps = d.snapshots;
  const player = (client: number, time: number): KillfeedPlayer => {
    const c = clients.at(client, time);
    return { client, name: c?.name || `#${client}`, team: c?.team ?? -1 };
  };
  const viewAt = (i: number) => {
    const s = snaps[Math.max(0, Math.min(i, snaps.length - 1))];
    const client = s?.viewClient ?? d.gamestates[0]?.clientNum ?? -1;
    return { killcam: s?.killcam ?? false, viewClient: client, viewTeam: clients.at(client, s?.demoTime ?? 0)?.team ?? -1 };
  };

  const maps = d.gamestates
    .filter((g) => g.demoTime >= 0)
    .map((g) => {
      const info = parseInfoString(g.configStrings[0] ?? "");
      return { time: g.demoTime, map: info.mapname ?? "", gametype: info.g_gametype ?? "" };
    });
  const gamestateAt = (time: number) => {
    let g = d.gamestates[0];
    for (const x of d.gamestates) if (x.demoTime >= 0 && x.demoTime <= time) g = x;
    return g;
  };

  const entries: KillfeedEntry[] = [];
  const lastObit = new Map<number, { key: string; time: number }>();
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    for (const e of s.entities) {
      if (e.eType !== ET_OBITUARY) continue;
      // An event entity stays in a few consecutive snapshots: report it once.
      const key = `${e.otherEntityNum}:${e.attackerEntityNum}:${e.eventParm}`;
      const prev = lastObit.get(e.number);
      lastObit.set(e.number, { key, time: s.demoTime });
      if (prev && prev.key === key && s.demoTime - prev.time < 1000) continue;
      const victimNum = e.otherEntityNum;
      if (victimNum >= MAX_CLIENTS) continue;
      const attackerNum = e.attackerEntityNum;
      const world = attackerNum >= MAX_CLIENTS;
      const victim = player(victimNum, s.demoTime);
      const attacker = world || attackerNum === victimNum ? null : player(attackerNum, s.demoTime);
      const weapons = (gamestateAt(s.demoTime)?.configStrings[CS_WEAPONS] ?? "").split(" ");
      // eventParm: weapon index (1-based), 0 = no weapon (e.g. the sabotage bomb), 128+n = means of death n.
      const special = (e.eventParm & 128) !== 0;
      const weapon = special || e.eventParm === 0 ? "" : (weapons[e.eventParm - 1] ?? "");
      const death = special ? (DEATHS[e.eventParm & 127] ?? "died") : weapon ? "" : "died";
      const gametype = parseInfoString(gamestateAt(s.demoTime)?.configStrings[0] ?? "").g_gametype;
      entries.push({
        type: "obituary",
        time: s.demoTime,
        ...viewAt(i),
        attacker,
        victim,
        weapon,
        death,
        mod: special ? e.eventParm & 127 : -1,
        kind: world
          ? "world"
          : attackerNum === victimNum
            ? "suicide"
            : gametype !== "dm" && attacker && attacker.team === victim.team && victim.team > 0
              ? "teamkill"
              : "kill",
      });
    }
  }

  // Game notifications (server commands e/f) and round restarts (B/n).
  const rounds = maps.map((m) => m.time);
  let si = 0;
  for (const c of d.serverCommands) {
    const type = c.text[0];
    while (si + 1 < snaps.length && snaps[si + 1].demoTime <= c.demoTime) si++;
    if (type === "e" || type === "f") {
      const { text, key } = renderMessage(commandArg(c.text), loc, false);
      if (text) entries.push({ type: "message", time: c.demoTime, ...viewAt(si), text, key });
    } else if ((type === "B" || type === "n") && (c.text.length === 1 || c.text[1] === " ")) {
      rounds.push(c.demoTime);
    }
  }
  entries.sort((a, b) => a.time - b.time);
  rounds.sort((a, b) => a - b);

  const sys = { ...parseInfoString(d.gamestates[0]?.configStrings[1] ?? ""), ...parseInfoString(d.gamestates[0]?.configStrings[0] ?? "") };
  return {
    durationMs: snaps.at(-1)?.demoTime ?? 0,
    recorder: d.gamestates[0]?.clientNum ?? -1,
    maps,
    rounds: [...new Set(rounds)],
    teamColors: {
      allies: parseColor(sys.g_TeamColor_Allies) ?? DEFAULT_TEAM_COLORS.allies,
      axis: parseColor(sys.g_TeamColor_Axis) ?? DEFAULT_TEAM_COLORS.axis,
    },
    entries,
  };
}

/** Icon name for an obituary, following an icon manifest's weapon/death tables (see killfeedAssets.ts). */
export function killIconName(
  entry: Pick<ObituaryEntry, "weapon" | "death">,
  manifest: { weapons: Record<string, string>; deaths: Record<string, string> },
): string {
  if (entry.death) return manifest.deaths[entry.death] ?? manifest.deaths.died ?? "skull";
  let w = entry.weapon.replace(/_mp$/, "");
  while (w) {
    if (manifest.weapons[w]) return manifest.weapons[w];
    if (w.startsWith("gl_") && manifest.weapons.gl) return manifest.weapons.gl;
    const cut = w.lastIndexOf("_");
    if (cut < 0) break;
    w = w.slice(0, cut);
  }
  return manifest.weapons.default ?? "skull";
}
