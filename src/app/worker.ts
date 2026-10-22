import { decodeDemo } from "../demo/decoder.ts";
import { extractKillfeed, type Killfeed } from "../demo/killfeed.ts";

export interface PlayerInfo {
  client: number;
  /** Every name this client slot had, color codes included. */
  names: string[];
  /** Team changes over time: [demo time ms, team]. */
  teams: [number, number][];
}

export type WorkerReply =
  | { ok: true; killfeed: Killfeed; players: PlayerInfo[]; decodeMs: number }
  | { ok: false; error: string };

self.onmessage = (e: MessageEvent<{ buffer: ArrayBuffer; strings: Record<string, string> }>) => {
  const started = performance.now();
  try {
    const d = decodeDemo(Buffer.from(e.data.buffer));
    if (!d.snapshots.length) throw new Error("No snapshots could be decoded: is this a CoD4 .dm_1 demo?");
    const killfeed = extractKillfeed(d, new Map(Object.entries(e.data.strings ?? {})));
    const players = new Map<number, PlayerInfo>();
    for (const c of d.clientChanges) {
      let p = players.get(c.client);
      if (!p) players.set(c.client, (p = { client: c.client, names: [], teams: [] }));
      if (c.name && !p.names.includes(c.name)) p.names.push(c.name);
      if (p.teams.at(-1)?.[1] !== c.team) p.teams.push([c.time, c.team]);
    }
    const reply: WorkerReply = { ok: true, killfeed, players: [...players.values()], decodeMs: performance.now() - started };
    (self as unknown as Worker).postMessage(reply);
  } catch (err) {
    const reply: WorkerReply = { ok: false, error: err instanceof Error ? err.message : String(err) };
    (self as unknown as Worker).postMessage(reply);
  }
};
