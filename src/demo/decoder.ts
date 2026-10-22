import { BitReader, COD4_PROTOCOL, COD4X_FALLBACK_PROTOCOL } from "./bitReader.ts";
import { parseDemo } from "./container.ts";
import { ENTITY_STATE_SIZE, ETYPE_LIST, STRUCT_SIZE, TABLES, type NetField } from "./netfieldsData.ts";

/**
 * Full snapshot decoder: Huffman + bit reader + net-field delta decoding.
 * Faithful port of the read path of Iswenzz/CoD4-DM1 (Demo.cpp / Msg.cpp).
 *
 * Produces, per decoded snapshot, the list of entities (number, eType, origin)
 * — which includes every player (ET_PLAYER) currently visible to the recorder.
 */

const SVC = { nop: 0, gamestate: 1, configstring: 2, baseline: 3, serverCommand: 4, snapshot: 6, EOF: 7, configclient: 11 };
const MAX_CONFIGSTRINGS = 2 * 2442;
const MAX_GENTITIES = 1024;
const MAX_CLIENTS = 64;
const MAX_PARSE_ENTITIES = 2048;
const MAX_PARSE_CLIENTS = 2048;
const PACKET_BACKUP = 32;
const PACKET_MASK = PACKET_BACKUP - 1;
const ENTITY_STATE_FIELDS_COUNT = 59;
const PLAYER_STATE_FIELDS_COUNT = 141;
const HUD_ELEM_FIELDS_COUNT = 40;
const NET_FIELDS_COUNT = 18;
const ET_PLAYER = 1;

const CLIENT_SIZE = STRUCT_SIZE.ClientStateFields;
const PS_SIZE = STRUCT_SIZE.PlayerStateFields;
const OBJ_SIZE = STRUCT_SIZE.ObjectiveFields;
const HUD_SIZE = STRUCT_SIZE.HudElemFields;

const ENTITY_FIELDS = TABLES.EntityStateFields;
const PLAYER_FIELDS = TABLES.PlayerStateFields;
const CLIENT_FIELDS = TABLES.ClientStateFields;
const HUD_FIELDS = TABLES.HudElemFields;
const OBJ_FIELDS = TABLES.ObjectiveFields;
const ENTITY_TABLE_BY_ETYPE = ETYPE_LIST.map((name) => TABLES[name]);

// entityState offsets we extract.
const OFF_NUMBER = 0;
const OFF_ETYPE = 4;
const OFF_POS_TRBASE = 24; // [0]=24 [1]=28 [2]=32
const OFF_APOS_TRBASE1 = 64;
const OFF_CLIENTNUM = 140;
const OFF_OTHER_ENTITY = 116;
const OFF_ATTACKER_ENTITY = 120;
const OFF_EVENT_PARM = 156;
const OFF_WEAPON = 196;
const PS_CLIENTNUM_OFFSET = PLAYER_FIELDS.find((f) => f.n === "ClientNum")!.o;
const PS_DELTATIME_OFFSET = PLAYER_FIELDS.find((f) => f.n === "deltaTime")!.o;
const CLIENT_TEAM_OFFSET = CLIENT_FIELDS.find((f) => f.n === "team")!.o;
const CLIENT_NETNAME_OFFSET = CLIENT_FIELDS.find((f) => f.n === "netname[0]")!.o;
const NETNAME_LEN = 16;
/** Config string holding the map center ("x y z"), used by stock origin decoding. */
const CS_MAP_CENTER = 12;

const mk = (size: number): DataView => new DataView(new ArrayBuffer(size));
const gU = (d: DataView, o: number) => d.getUint32(o, true);
const sU = (d: DataView, o: number, v: number) => d.setUint32(o, v >>> 0, true);
const gF = (d: DataView, o: number) => d.getFloat32(o, true);
const sF = (d: DataView, o: number, v: number) => d.setFloat32(o, v, true);
const gB = (d: DataView, o: number) => d.getUint8(o);
const sB = (d: DataView, o: number, v: number) => d.setUint8(o, v & 0xff);
function readCString(d: DataView, off: number, len: number): string {
  const bytes = new Uint8Array(d.buffer, d.byteOffset + off, len);
  const end = bytes.indexOf(0);
  return Buffer.from(bytes.subarray(0, end === -1 ? len : end)).toString("latin1");
}
function copyDV(dst: DataView, src: DataView, size: number): void {
  new Uint8Array(dst.buffer, dst.byteOffset, size).set(new Uint8Array(src.buffer, src.byteOffset, size));
}
const minBits = (x: number) => 32 - Math.clz32(x);

interface Snap {
  valid: boolean;
  serverTime: number;
  messageNum: number;
  deltaNum: number;
  snapFlags: number;
  numEntities: number;
  parseEntitiesNum: number;
  numClients: number;
  parseClientsNum: number;
}

export interface DecodedEntity {
  number: number;
  eType: number;
  clientNum: number;
  /** 0=free, 1=axis/red, 2=allies/blue, 3=spectator, -1=unknown. */
  team: number;
  origin: [number, number, number];
  yaw: number;
  /** Event entities (e.g. obituaries): the entity the event is about, and who caused it. */
  otherEntityNum: number;
  attackerEntityNum: number;
  eventParm: number;
  weapon: number;
}
export interface DecodedSnapshot {
  serverTime: number;
  /** Playback clock in ms from the first snapshot; unlike serverTime it never jumps back (map changes). */
  demoTime: number;
  /** Client whose view this snapshot shows (the recorder, or whoever they spectate). */
  viewClient: number;
  /** True while a killcam plays (playerState.deltaTime is non-zero, as in CG_SetNextSnap). */
  killcam: boolean;
  entities: DecodedEntity[];
}
export interface DeathEvent {
  time: number;
  origin: [number, number, number];
  /** Best-effort victim, matched by nearest live player to the corpse spawn. */
  victimClient: number;
  victimTeam: number;
  victimName: string;
}
/** One gamestate (a map load): its config strings and the recording player's client number. */
export interface Gamestate {
  /** Server time of the first snapshot after this gamestate (0 if none followed). */
  serverTime: number;
  /** Demo clock (see DecodedSnapshot.demoTime) of that snapshot, -1 if none followed. */
  demoTime: number;
  clientNum: number;
  configStrings: Record<number, string>;
}
/** A client's name or team as first seen, or a change of either. */
export interface ClientChange {
  /** Demo clock in ms (see DecodedSnapshot.demoTime). */
  time: number;
  client: number;
  name: string;
  team: number;
}
export interface DecodeResult {
  protocol: number;
  configStrings: Record<number, string>;
  clientNames: Record<number, { name: string; clantag: string }>;
  snapshots: DecodedSnapshot[];
  /** Reliable server commands, once each (resends are dropped by sequence number). */
  serverCommands: { time: number; demoTime: number; seq: number; text: string }[];
  deaths: DeathEvent[];
  gamestates: Gamestate[];
  clientChanges: ClientChange[];
}

const ET_PLAYER_CORPSE = 2;
/**
 * Derive death events from corpse (ET_PLAYER_CORPSE) spawns. A death is the
 * first appearance of a corpse entity, deduped against PVS flicker (the same
 * corpse leaving and re-entering view within a short window).
 */
function extractDeaths(
  snapshots: DecodedSnapshot[],
  names: Record<number, { name: string; clantag: string }>,
): DeathEvent[] {
  const lastSeen = new Map<number, number>();
  const deaths: DeathEvent[] = [];
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    for (const e of s.entities) {
      if (e.eType !== ET_PLAYER_CORPSE) continue;
      const prev = lastSeen.get(e.number);
      if (prev === undefined || s.serverTime - prev > 2000) {
        // Victim = nearest live player to the corpse spawn in the prior few snapshots.
        let best: DecodedEntity | null = null;
        let bestD = 130 * 130;
        for (let j = Math.max(0, i - 6); j < i; j++) {
          for (const p of snapshots[j].entities) {
            if (p.eType !== ET_PLAYER) continue;
            const dx = p.origin[0] - e.origin[0];
            const dy = p.origin[1] - e.origin[1];
            const dz = p.origin[2] - e.origin[2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < bestD) {
              bestD = d2;
              best = p;
            }
          }
        }
        deaths.push({
          time: s.serverTime,
          origin: [...e.origin],
          victimClient: best ? best.clientNum : -1,
          victimTeam: best ? best.team : -1,
          victimName: best ? (names[best.clientNum]?.name ?? `#${best.clientNum}`) : "",
        });
      }
      lastSeen.set(e.number, s.serverTime);
    }
  }
  return deaths;
}

class Decoder {
  r!: BitReader;
  protocol: number;
  configStrings: Record<number, string> = {};
  clientNames: Record<number, { name: string; clantag: string }> = {};
  serverCommands: { time: number; demoTime: number; seq: number; text: string }[] = [];
  lastCommandSeq = 0;
  demoClock = 0;
  prevSnapTime = -1;
  gamestates: Gamestate[] = [];
  clientChanges: ClientChange[] = [];
  lastServerTime = 0;
  serverConfigSequence = 0;
  gamestateCount = 0;
  mapCenter: [number, number, number] = [0, 0, 0];

  parseEntities: DataView[] = Array.from({ length: MAX_PARSE_ENTITIES }, () => mk(ENTITY_STATE_SIZE));
  parseClients: DataView[] = Array.from({ length: MAX_PARSE_CLIENTS }, () => mk(CLIENT_SIZE));
  entityBaselines: DataView[] = Array.from({ length: MAX_GENTITIES }, () => mk(ENTITY_STATE_SIZE));
  parseEntitiesNum = 0;
  parseClientsNum = 0;
  /** Called with a field's name and the byte offset of its raw 32-bit value (type -88 fields). */
  onRawField?: (name: string, byteOffset: number, raw: number) => void;
  teamByClient = new Map<number, number>();
  lastClient = new Map<number, ClientChange>();
  snapMessageNum = 0;
  snapshots: Snap[] = Array.from({ length: PACKET_BACKUP }, () => emptySnap());
  snapPs: DataView[] = Array.from({ length: PACKET_BACKUP }, () => mk(PS_SIZE));

  nullEntity = mk(ENTITY_STATE_SIZE);
  nullClient = mk(CLIENT_SIZE);
  nullPs = mk(PS_SIZE);
  curPs = mk(PS_SIZE);
  objFrom = mk(OBJ_SIZE);
  objTo = mk(OBJ_SIZE);
  hudFrom = Array.from({ length: 31 }, () => mk(HUD_SIZE));
  hudTo = Array.from({ length: 31 }, () => mk(HUD_SIZE));

  out: DecodedSnapshot[] = [];

  constructor(protocol: number) {
    this.protocol = protocol;
  }

  // --- low-level delta field decode (port of Demo::ReadDeltaField) ---
  readDeltaField(time: number, from: DataView, to: DataView, f: NetField, noXor: boolean): void {
    const r = this.r;
    const off = f.o;
    const zero = noXor && f.c === 3;
    const fromU = zero ? 0 : gU(from, off);
    const fromF = zero ? 0 : gF(from, off);

    if (f.c !== 2) {
      if (!r.readBit()) {
        sU(to, off, fromU);
        return;
      }
    }
    const bits = f.b;
    if (bits === 0) {
      if (!r.readBit()) {
        sU(to, off, r.readBit() << 31);
        return;
      }
      if (!r.readBit()) {
        const b = r.readBits(5);
        const v = ((32 * r.readByte() + b) ^ ((fromF | 0) + 4096)) - 4096;
        sF(to, off, v);
        return;
      }
      sU(to, off, r.readInt() ^ fromU);
      return;
    }
    switch (bits) {
      case -89:
        if (!r.readBit()) {
          const b = r.readBits(5);
          const l = ((32 * r.readByte() + b) ^ ((fromF | 0) + 4096)) - 4096;
          sF(to, off, l);
          return;
        }
        sU(to, off, r.readInt() ^ fromU);
        return;
      case -88:
        this.onRawField?.(f.n, r.readCount, r.buffer.readUInt32LE(r.readCount));
        sU(to, off, r.readInt() ^ fromU);
        return;
      case -100:
        if (!r.readBit()) {
          sF(to, off, 0);
          return;
        }
        sF(to, off, r.readAngle16());
        return;
      case -99:
        if (r.readBit()) {
          if (!r.readBit()) {
            const b = r.readBits(4);
            const v = ((16 * r.readByte() + b) ^ ((fromF | 0) + 2048)) - 2048;
            sF(to, off, v);
            return;
          }
          sU(to, off, r.readInt() ^ fromU);
          return;
        }
        sU(to, off, 0);
        return;
      case -98:
        sU(to, off, this.readEFlags(fromU));
        return;
      case -97:
        if (r.readBit()) sU(to, off, r.readInt());
        else sU(to, off, time - r.readBits(8));
        return;
      case -96:
        sU(to, off, this.readDeltaGroundEntity());
        return;
      case -95:
        sU(to, off, 100 * r.readBits(7));
        return;
      case -94:
      case -93:
        sU(to, off, r.readByte());
        return;
      case -92:
      case -91:
        sF(to, off, r.readOriginFloat(bits, fromF));
        return;
      case -90:
        sF(to, off, r.readOriginZFloat(fromF));
        return;
      case -87:
        sF(to, off, r.readAngle16());
        return;
      case -86:
        sF(to, off, r.readBits(5) / 10.0 + 1.399999976158142);
        return;
      case -85:
        if (r.readBit()) {
          sU(to, off, fromU);
          sB(to, off + 3, (gB(from, off + 3) !== 0 ? 1 : 0) - 1);
          return;
        }
        if (!r.readBit()) {
          sB(to, off, r.readByte());
          sB(to, off + 1, r.readByte());
          sB(to, off + 2, r.readByte());
        }
        sB(to, off + 3, 8 * r.readBits(5));
        return;
      default: {
        if (!r.readBit()) {
          sU(to, off, 0);
          return;
        }
        const ab = Math.abs(bits);
        let bv = ab & 7;
        let t = bv ? r.readBits(bv) : 0;
        for (; bv < ab; bv += 8) t |= r.readByte() << bv;
        const mask = ab === 32 ? -1 : (1 << ab) - 1;
        t = t ^ (fromU & mask);
        if (bits < 0 && (t >> (ab - 1)) & 1) t |= ~mask;
        sU(to, off, t);
        return;
      }
    }
  }

  readEFlags(oldFlags: number): number {
    const r = this.r;
    if (r.readBit() === 1) {
      let value = 0;
      for (let i = 0; i < 24; i += 8) value |= r.readByte() << i;
      return value >>> 0;
    }
    const bitChanged = r.readBits(5);
    return (oldFlags ^ (1 << bitChanged)) >>> 0;
  }

  readDeltaGroundEntity(): number {
    const r = this.r;
    if (r.readBit() === 1) return 1022;
    if (r.readBit() === 1) return 0;
    let value = r.readBits(2);
    for (let j = 2; j < 10; j += 8) value |= r.readByte() << j;
    return value;
  }

  readLastChangedField(total: number): number {
    return this.r.readBits(minBits(total));
  }

  readEntityIndex(indexBits: number): number {
    const r = this.r;
    if (r.readBit()) r.lastRefEntity++;
    else if (indexBits !== 10 || r.readBit()) r.lastRefEntity = r.readBits(indexBits);
    else r.lastRefEntity += r.readBits(4);
    return r.lastRefEntity;
  }

  // port of Demo::ReadDeltaFields (+ entity eType table switch)
  readDeltaFields(time: number, from: DataView, to: DataView, numFields: number, fields: NetField[], entitySwitch: boolean): void {
    const r = this.r;
    if (!r.readBit()) {
      copyDV(to, from, entitySwitch ? ENTITY_STATE_SIZE : numFields * 4);
      return;
    }
    let lc: number;
    if (numFields === ENTITY_STATE_FIELDS_COUNT) lc = this.readLastChangedField(0x3d);
    else lc = this.readLastChangedField(numFields);
    if (r.overflowed || lc > numFields + 4) {
      r.overflowed = true;
      return;
    }
    this.readDeltaField(time, from, to, fields[0], false);

    if (entitySwitch) {
      let etype = gU(to, OFF_ETYPE);
      if (etype > NET_FIELDS_COUNT - 1) etype = NET_FIELDS_COUNT - 1;
      fields = ENTITY_TABLE_BY_ETYPE[etype];
      numFields = fields.length;
    }
    for (let i = 1; i < lc && i < fields.length; i++) this.readDeltaField(time, from, to, fields[i], false);
    for (let i = lc; i < numFields; i++) {
      const o = fields[i].o;
      sU(to, o, gU(from, o));
    }
  }

  readDeltaStruct(from: DataView, to: DataView, number: number, numFields: number, fields: NetField[], entitySwitch: boolean): boolean {
    if (this.r.readBit() === 1) return true;
    sU(to, 0, number);
    this.readDeltaFields(0, from, to, numFields, fields, entitySwitch);
    return false;
  }

  readDeltaEntity(time: number, from: DataView, to: DataView, number: number): boolean {
    return this.readDeltaStruct(from, to, number, ENTITY_STATE_FIELDS_COUNT, ENTITY_FIELDS, true);
  }
  readDeltaClient(from: DataView, to: DataView, number: number): boolean {
    return this.readDeltaStruct(from, to, number, CLIENT_FIELDS.length, CLIENT_FIELDS, false);
  }

  readDeltaObjective(time: number, from: DataView, to: DataView): void {
    const r = this.r;
    if (r.readBit()) {
      for (let i = 0; i < OBJ_FIELDS.length; i++) this.readDeltaField(time, from, to, OBJ_FIELDS[i], false);
    }
  }

  readDeltaHudElems(time: number, from: DataView[], to: DataView[]): void {
    const r = this.r;
    const inuse = r.readBits(5);
    for (let i = 0; i < inuse; i++) {
      const lc = r.readBits(6);
      if (lc >>> 0 >= HUD_ELEM_FIELDS_COUNT) {
        r.overflowed = true;
        return;
      }
      for (let y = 0; y <= lc; y++) this.readDeltaField(time, from[i], to[i], HUD_FIELDS[y], false);
    }
    // Trailing clear loop in the original consumes no bits; skipped.
  }

  readDeltaPlayerState(time: number, from: DataView, to: DataView): void {
    const r = this.r;
    copyDV(to, from, PS_SIZE);
    const readOriginAndVel = r.readBit() > 0;
    const lastChanged = this.readLastChangedField(PLAYER_STATE_FIELDS_COUNT);
    if (lastChanged >>> 0 > PLAYER_STATE_FIELDS_COUNT) {
      r.overflowed = true;
      return;
    }
    for (let i = 0; i < lastChanged && i < PLAYER_FIELDS.length; i++) {
      const noXor = readOriginAndVel && PLAYER_FIELDS[i].c === 3;
      this.readDeltaField(time, from, to, PLAYER_FIELDS[i], noXor);
    }
    // (predicted-origin fallback omitted: affects only playerstate output, no bits)

    // stats
    if (r.readBit()) {
      const sb = r.readBits(5);
      if (sb & 1) r.readShort();
      if (sb & 2) r.readShort();
      if (sb & 4) r.readShort();
      if (sb & 8) r.readBits(6);
      if (sb & 16) r.readByte();
    }
    // ammo
    if (r.readBit()) {
      for (let j = 0; j < 4; j++) {
        if (r.readBit()) {
          const bits = r.readShort();
          for (let i = 0; i < 16; i++) if (bits & (1 << i)) r.readShort();
        }
      }
    }
    // ammo in clip
    for (let j = 0; j < 8; j++) {
      if (r.readBit()) {
        const bits = r.readShort();
        for (let i = 0; i < 16; i++) if (bits & (1 << i)) r.readShort();
      }
    }
    // objectives
    if (r.readBit()) {
      for (let f = 0; f < 16; f++) {
        r.readBits(3);
        this.readDeltaObjective(time, this.objFrom, this.objTo);
      }
    }
    // huds
    if (r.readBit()) {
      this.readDeltaHudElems(time, this.hudFrom, this.hudTo);
      this.readDeltaHudElems(time, this.hudFrom, this.hudTo);
    }
    // weapon models
    if (r.readBit()) {
      for (let i = 0; i < 128; i++) r.readByte();
    }
  }

  checkSnapshotValidity(old: Snap, deltaNum: number): boolean {
    if (!old.valid) return false;
    if (this.snapshots[deltaNum & PACKET_MASK].messageNum !== deltaNum) return false;
    if (this.parseEntitiesNum - this.snapshots[deltaNum & PACKET_MASK].parseEntitiesNum > 1920) return false;
    if (this.parseClientsNum - this.snapshots[deltaNum & PACKET_MASK].parseClientsNum > 1920) return false;
    return true;
  }

  parsePacketEntities(time: number, from: Snap | null, to: Snap): void {
    const r = this.r;
    let oldstate: DataView | null = null;
    let oldindex = 0;
    let oldnum: number;
    let newnum = -1;
    to.parseEntitiesNum = this.parseEntitiesNum;
    to.numEntities = 0;

    if (from && from.numEntities > 0) {
      oldstate = this.parseEntities[from.parseEntitiesNum & (MAX_PARSE_ENTITIES - 1)];
      oldnum = gU(oldstate, OFF_NUMBER);
    } else oldnum = 99999;

    while (!r.overflowed) {
      newnum = this.readEntityIndex(10);
      if (newnum === 1023) break;
      if (r.readCount > r.curSize || newnum >>> 0 >= 1024) {
        r.overflowed = true;
        return;
      }
      while (oldnum < newnum && !r.overflowed && oldstate) {
        copyDV(this.parseEntities[this.parseEntitiesNum++ & (MAX_PARSE_ENTITIES - 1)], oldstate, ENTITY_STATE_SIZE);
        to.numEntities++;
        if (from && ++oldindex < from.numEntities) {
          oldstate = this.parseEntities[(oldindex + from.parseEntitiesNum) & (MAX_PARSE_ENTITIES - 1)];
          oldnum = gU(oldstate, OFF_NUMBER);
        } else oldnum = 99999;
      }
      if (oldnum === newnum) {
        this.deltaEntity(time, to, newnum, oldstate!);
        if (from && ++oldindex < from.numEntities) {
          oldstate = this.parseEntities[(oldindex + from.parseEntitiesNum) & (MAX_PARSE_ENTITIES - 1)];
          oldnum = gU(oldstate, OFF_NUMBER);
        } else oldnum = 99999;
      } else {
        this.deltaEntity(time, to, newnum, this.entityBaselines[newnum]);
      }
    }
    while (oldnum !== 99999 && !r.overflowed && oldstate && from) {
      copyDV(this.parseEntities[this.parseEntitiesNum++ & (MAX_PARSE_ENTITIES - 1)], oldstate, ENTITY_STATE_SIZE);
      to.numEntities++;
      if (++oldindex < from.numEntities) {
        oldstate = this.parseEntities[(oldindex + from.parseEntitiesNum) & (MAX_PARSE_ENTITIES - 1)];
        oldnum = gU(oldstate, OFF_NUMBER);
      } else oldnum = 99999;
    }
  }

  deltaEntity(time: number, frame: Snap, newnum: number, old: DataView): void {
    const to = this.parseEntities[this.parseEntitiesNum & (MAX_PARSE_ENTITIES - 1)];
    if (!this.readDeltaEntity(time, old, to, newnum)) {
      this.parseEntitiesNum++;
      frame.numEntities++;
    }
  }

  parsePacketClients(time: number, from: Snap | null, to: Snap): void {
    const r = this.r;
    let oldstate: DataView | null = null;
    let oldindex = 0;
    let oldnum: number;
    to.parseClientsNum = this.parseClientsNum;
    to.numClients = 0;

    if (from && oldindex < from.numClients) {
      oldstate = this.parseClients[(oldindex + from.parseClientsNum) & (MAX_PARSE_CLIENTS - 1)];
      oldnum = gU(oldstate, 0);
    } else oldnum = 99999;

    while (!r.overflowed && r.readBit()) {
      const newnum = this.readEntityIndex(6);
      if (r.readCount > r.curSize || newnum >>> 0 >= MAX_CLIENTS) {
        r.overflowed = true;
        return;
      }
      while (oldnum < newnum && oldstate) {
        this.deltaClient(to, oldnum, oldstate, true);
        if (from && ++oldindex < from.numClients) {
          oldstate = this.parseClients[(oldindex + from.parseClientsNum) & (MAX_PARSE_CLIENTS - 1)];
          oldnum = gU(oldstate, 0);
        } else oldnum = 99999;
      }
      if (oldnum === newnum) {
        this.deltaClient(to, newnum, oldstate!, false);
        if (from && ++oldindex < from.numClients) {
          oldstate = this.parseClients[(oldindex + from.parseClientsNum) & (MAX_PARSE_CLIENTS - 1)];
          oldnum = gU(oldstate, 0);
        } else oldnum = 99999;
      } else {
        this.deltaClient(to, newnum, this.nullClient, false);
      }
    }
    while (oldnum !== 99999 && !r.overflowed && oldstate && from) {
      this.deltaClient(to, oldnum, oldstate, true);
      if (++oldindex < from.numClients) {
        oldstate = this.parseClients[(oldindex + from.parseClientsNum) & (MAX_PARSE_CLIENTS - 1)];
        oldnum = gU(oldstate, 0);
      } else oldnum = 99999;
    }
  }

  deltaClient(frame: Snap, newnum: number, old: DataView, unchanged: boolean): void {
    const state = this.parseClients[this.parseClientsNum & (MAX_PARSE_CLIENTS - 1)];
    if (unchanged) copyDV(state, old, CLIENT_SIZE);
    else if (this.readDeltaClient(old, state, newnum)) return;
    this.parseClientsNum++;
    frame.numClients++;
  }

  parseSnapshot(msgSeq: number): void {
    const r = this.r;
    let old: Snap = emptySnap();
    const cur = emptySnap();
    cur.serverTime = r.readInt();
    this.lastServerTime = cur.serverTime;
    // Demo clock: follows serverTime, but a jump (map change, server restart) counts as no time.
    if (this.prevSnapTime >= 0) {
      const dt = cur.serverTime - this.prevSnapTime;
      if (dt > 0 && dt < 5000) this.demoClock += dt;
    }
    this.prevSnapTime = cur.serverTime;
    const gs = this.gamestates.at(-1);
    if (gs && gs.demoTime < 0) {
      gs.serverTime = cur.serverTime;
      gs.demoTime = this.demoClock;
    }
    cur.messageNum = msgSeq;
    const deltaByte = r.readByte();
    cur.deltaNum = deltaByte === 0 ? -1 : cur.messageNum - deltaByte;
    cur.snapFlags = r.readByte();

    let oldPs: DataView = this.nullPs;
    if (cur.deltaNum > 0) {
      old = this.snapshots[cur.deltaNum & PACKET_MASK];
      if (!this.checkSnapshotValidity(old, cur.deltaNum)) {
        r.discard();
        return;
      }
      oldPs = this.snapPs[cur.deltaNum & PACKET_MASK];
    }
    cur.valid = true;

    this.readDeltaPlayerState(cur.serverTime, old.valid ? oldPs : this.nullPs, this.curPs);
    r.lastRefEntity = -1;
    this.parsePacketEntities(cur.serverTime, old.valid ? old : null, cur);
    r.lastRefEntity = -1;
    this.parsePacketClients(cur.serverTime, old.valid ? old : null, cur);
    if (r.overflowed) return;

    this.snapMessageNum = cur.messageNum;
    // store snapshot + its playerstate for future deltas
    const slot = this.snapMessageNum & PACKET_MASK;
    this.snapshots[slot] = cur;
    copyDV(this.snapPs[slot], this.curPs, PS_SIZE);

    // update per-client team from this snapshot's clients
    for (let k = 0; k < cur.numClients; k++) {
      const c = this.parseClients[(cur.parseClientsNum + k) & (MAX_PARSE_CLIENTS - 1)];
      const idx = gU(c, 0);
      if (idx >= 0 && idx < MAX_CLIENTS) {
        const team = gU(c, CLIENT_TEAM_OFFSET);
        this.teamByClient.set(idx, team);
        // Stock CoD4 has no svc_configclient; names live in clientState.netname.
        if (this.protocol === COD4_PROTOCOL) {
          const name = readCString(c, CLIENT_NETNAME_OFFSET, NETNAME_LEN);
          if (name) this.clientNames[idx] = { name, clantag: "" };
        }
        const name = this.clientNames[idx]?.name ?? "";
        const last = this.lastClient.get(idx);
        if (!last || last.name !== name || last.team !== team) {
          const change = { time: this.demoClock, client: idx, name, team };
          this.clientChanges.push(change);
          this.lastClient.set(idx, change);
        }
      }
    }

    // extract entities for this snapshot
    const entities: DecodedEntity[] = [];
    for (let k = 0; k < cur.numEntities; k++) {
      const e = this.parseEntities[(cur.parseEntitiesNum + k) & (MAX_PARSE_ENTITIES - 1)];
      const clientNum = gU(e, OFF_CLIENTNUM);
      entities.push({
        number: gU(e, OFF_NUMBER),
        eType: gU(e, OFF_ETYPE),
        clientNum,
        team: this.teamByClient.get(clientNum) ?? -1,
        origin: [gF(e, OFF_POS_TRBASE), gF(e, OFF_POS_TRBASE + 4), gF(e, OFF_POS_TRBASE + 8)],
        yaw: gF(e, OFF_APOS_TRBASE1),
        otherEntityNum: gU(e, OFF_OTHER_ENTITY),
        attackerEntityNum: gU(e, OFF_ATTACKER_ENTITY),
        eventParm: gU(e, OFF_EVENT_PARM),
        weapon: gU(e, OFF_WEAPON),
      });
    }
    this.out.push({
      serverTime: cur.serverTime,
      demoTime: this.demoClock,
      viewClient: gU(this.curPs, PS_CLIENTNUM_OFFSET),
      killcam: gU(this.curPs, PS_DELTATIME_OFFSET) !== 0,
      entities,
    });
  }

  /** Stock CoD4 gamestate: short count, then a 1-bit "next index" flag or a 12-bit index per string. */
  parseGamestate(): void {
    const r = this.r;
    r.lastRefEntity = -1;
    this.lastCommandSeq = r.readInt(); // serverCommandSequence
    for (;;) {
      const cmd = r.readByte();
      if (cmd === SVC.EOF || cmd === -1) break;
      if (cmd === SVC.configstring) {
        let count = r.readShort();
        if (count < 0 || count >= MAX_CONFIGSTRINGS) break;
        let idx = -1;
        while (count > 0 && !r.overflowed) {
          idx = r.readBit() ? idx + 1 : r.readBits(12);
          const s = r.readString();
          if (idx === CS_MAP_CENTER) this.setMapCenter(s);
          if (idx >= 0 && idx < MAX_CONFIGSTRINGS && s.length) this.configStrings[idx] = s;
          count--;
        }
      } else if (cmd === SVC.baseline) {
        const newnum = this.readEntityIndex(10);
        if (newnum >>> 0 >= 1024) {
          r.overflowed = true;
          return;
        }
        this.readDeltaEntity(0, this.nullEntity, this.entityBaselines[newnum], newnum);
      } else break;
      if (r.overflowed) break;
    }
    this.addGamestate(r.readInt()); // clientNum
    r.readInt(); // checksumFeed
  }

  addGamestate(clientNum: number): void {
    this.gamestates.push({ serverTime: 0, demoTime: -1, clientNum, configStrings: this.configStrings });
  }

  /** A later gamestate (map change) invalidates baselines and delta history (port of Demo::ReadMessage). */
  resetForNewGamestate(): void {
    this.parseEntitiesNum = 0;
    this.parseClientsNum = 0;
    this.configStrings = {};
    for (const b of this.entityBaselines) new Uint8Array(b.buffer).fill(0);
    this.snapshots = Array.from({ length: PACKET_BACKUP }, () => emptySnap());
  }

  setMapCenter(s: string): void {
    const v = s.trim().split(/\s+/).map(Number);
    if (v.length >= 3 && v.every(Number.isFinite)) {
      this.mapCenter = [v[0], v[1], v[2]];
      this.r.mapCenter = this.mapCenter;
    }
  }

  parseGamestateX(): void {
    const r = this.r;
    r.lastRefEntity = -1;
    this.lastCommandSeq = r.readInt(); // serverCommandSequence
    for (;;) {
      const cmd = r.readByte();
      if (cmd === SVC.EOF || cmd === -1) break;
      if (cmd === SVC.configstring) {
        let count = r.readInt();
        if (count < 0 || count >= 2 * MAX_CONFIGSTRINGS) break;
        while (count > 0 && !r.overflowed) {
          const idx = r.readInt();
          const s = r.readString();
          if (idx === CS_MAP_CENTER) this.setMapCenter(s);
          if (idx >= 0 && idx < 2 * MAX_CONFIGSTRINGS && s.length) this.configStrings[idx] = s;
          count--;
        }
      } else if (cmd === SVC.baseline) {
        const newnum = this.readEntityIndex(10);
        if (newnum >>> 0 >= 1024) {
          r.overflowed = true;
          return;
        }
        this.readDeltaEntity(0, this.nullEntity, this.entityBaselines[newnum], newnum);
      } else if (cmd === SVC.configclient) {
        const clientnum = r.readByte();
        const name = r.readString();
        const clantag = r.readString();
        if (clientnum >= 0 && clientnum < MAX_CLIENTS) this.clientNames[clientnum] = { name, clantag };
      } else break;
      if (r.overflowed) break;
    }
    this.serverConfigSequence = r.readInt();
    this.addGamestate(r.readInt()); // clientNum
    r.readInt(); // checksumFeed
    if (this.protocol === COD4X_FALLBACK_PROTOCOL + 1) r.readInt(); // dbChecksumFeed
  }

  processMessage(payload: Buffer, msgSeq: number): void {
    this.r = BitReader.fromCompressed(payload, this.protocol);
    const r = this.r;
    r.mapCenter = this.mapCenter;
    for (;;) {
      if (r.readCount > r.curSize) break;
      const cmd = r.readByte();
      if (cmd === SVC.EOF || cmd === -1) break;
      if (cmd === SVC.gamestate) {
        if (++this.gamestateCount > 1) this.resetForNewGamestate();
        if (this.protocol === COD4_PROTOCOL) this.parseGamestate();
        else this.parseGamestateX();
      } else if (cmd === SVC.serverCommand) {
        const seq = r.readInt();
        const text = r.readString();
        // Reliable commands are resent until acknowledged; keep only the first copy.
        if (seq > this.lastCommandSeq) {
          this.lastCommandSeq = seq;
          if (text.length) this.serverCommands.push({ time: this.lastServerTime, demoTime: this.demoClock, seq, text });
        }
      } else if (cmd === SVC.snapshot) {
        this.parseSnapshot(msgSeq);
        break; // one snapshot per message
      } else if (cmd === SVC.configclient) {
        r.readInt();
        r.readByte();
        r.readString();
        r.readString();
      } else break;
      if (r.overflowed) break;
    }
  }
}

function emptySnap(): Snap {
  return {
    valid: false,
    serverTime: 0,
    messageNum: 0,
    deltaNum: 0,
    snapFlags: 0,
    numEntities: 0,
    parseEntitiesNum: 0,
    numClients: 0,
    parseClientsNum: 0,
  };
}

/**
 * Byte offsets (and raw values), in each decompressed snapshot message, of a raw 32-bit networked field (type -88,
 * sent as value XOR previous value). Keyed by the message's index among the demo's snapshot records.
 */
export function findRawFieldOffsets(buf: Buffer, fieldName: string): Map<number, { offset: number; raw: number }[]> {
  const { protocol, snapshots } = parseDemo(buf, { keepSnapshotPayloads: true });
  const dec = new Decoder(protocol?.protocol ?? COD4_PROTOCOL);
  const out = new Map<number, { offset: number; raw: number }[]>();
  let index = 0;
  dec.onRawField = (name, offset, raw) => {
    if (name !== fieldName) return;
    let list = out.get(index);
    if (!list) out.set(index, (list = []));
    list.push({ offset, raw });
  };
  for (const snap of snapshots) {
    if (snap.payload.length) dec.processMessage(snap.payload, snap.serverMsgSeq);
    index++;
  }
  return out;
}

/** Decode all snapshots in a demo, returning per-snapshot entity lists. */
export function decodeDemo(buf: Buffer): DecodeResult {
  const { protocol, snapshots } = parseDemo(buf, { keepSnapshotPayloads: true });
  const proto = protocol?.protocol ?? COD4_PROTOCOL;
  const dec = new Decoder(proto);
  for (const snap of snapshots) {
    if (!snap.payload.length) continue;
    dec.processMessage(snap.payload, snap.serverMsgSeq);
  }
  return {
    protocol: proto,
    configStrings: dec.configStrings,
    clientNames: dec.clientNames,
    snapshots: dec.out,
    serverCommands: dec.serverCommands,
    deaths: extractDeaths(dec.out, dec.clientNames),
    gamestates: dec.gamestates,
    clientChanges: dec.clientChanges,
  };
}
