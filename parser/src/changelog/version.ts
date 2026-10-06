import sqlite, { Database } from "better-sqlite3";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { EffectInstance, I18n, LANGS, Lang, effects } from "./model";

/** JSON exports read next to dofus.sqlite: the database cannot link these effects to their item or set */
export const JSON_EXPORTS = ["itemsdata.json", "itemsetsdata.json", "recipesdata.json"] as const;
export type JsonExport = (typeof JSON_EXPORTS)[number];

interface UnityRef {
  rid: string;
  type: { class: string };
  data: Record<string, any>;
}

/** One release of the game data: its database, translations and JSON exports */
export class GameVersion {
  readonly db: Database;
  private names = new Map<number, I18n>();
  private translate: sqlite.Statement;
  private exports = new Map<JsonExport, UnityRef[]>();
  private rolledEffects?: Set<number>;

  constructor(
    readonly tag: string,
    sqlitePath: string,
    private jsonPaths: Record<JsonExport, string>,
  ) {
    this.db = new sqlite(sqlitePath, { fileMustExist: true });
    // CAST: translations.id is TEXT in older releases, INTEGER in newer ones; either way the index is used
    this.translate = this.db.prepare(`SELECT lang, value FROM translations WHERE id = CAST(? AS TEXT)`);
  }

  all<T = Record<string, any>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  hasTable(table: string) {
    return !!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  }

  /** A text in every language, empty when the id has none */
  text(id: unknown): I18n {
    const numeric = Number(id);
    if (!Number.isFinite(numeric) || numeric <= 0) return {};
    let value = this.names.get(numeric);
    if (!value) {
      value = {};
      for (const row of this.translate.all(String(numeric)) as { lang: Lang; value: string | null }[]) {
        const trimmed = row.value?.trim();
        if (trimmed && (LANGS as readonly string[]).includes(row.lang)) value[row.lang] = trimmed;
      }
      this.names.set(numeric, value);
    }
    return value;
  }

  /** References of a Unity JSON export, rids kept as strings (they exceed 2^53) */
  refs(file: JsonExport): UnityRef[] {
    let refs = this.exports.get(file);
    if (!refs) {
      const raw = fs.readFileSync(this.jsonPaths[file], "utf8");
      refs = JSON.parse(raw.replace(/"rid":\s*(-?\d+)/g, '"rid":"$1"')).references.RefIds as UnityRef[];
      this.exports.set(file, refs);
    }
    return refs;
  }

  /**
   * What pairs an effect line with its counterpart in another version. Rolled values (characteristics, damage)
   * pair by effect, so a new roll is a change; other effects name an object in diceNum (a spell to modify,
   * a monster to summon...) and only pair with a line about the same object.
   */
  effectKey = (effect: EffectInstance) => {
    this.rolledEffects ??= new Set(
      this.all<{ id: number }>(`SELECT id FROM EffectData WHERE useDice = 1 OR characteristic > 0`).map((row) => row.id),
    );
    return this.rolledEffects.has(effect.effectId) ? String(effect.effectId) : `${effect.effectId}:${effect.diceNum}`;
  };

  /** Effect lines with their pairing keys */
  effects(lines: EffectInstance[]) {
    return effects(lines, lines.map(this.effectKey));
  }

  close() {
    this.db.close();
  }
}

export const parseJson = <T = any>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

/** Unity serializes arrays as { "Array": [...] } */
export const unwrapArray = <T = any>(value: unknown): T[] =>
  Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as any).Array) ? (value as any).Array : [];

/** Since 3.7 the game calls the effect `actionId` (EffectData.id, what `effectId` used to be) */
export const effectInstance = (data: Record<string, any>): EffectInstance => ({
  effectId: data.effectId ?? data.actionId,
  diceNum: data.diceNum ?? 0,
  diceSide: data.diceSide ?? 0,
  value: data.value ?? 0,
  duration: data.duration ?? 0,
  m_flags: data.m_flags ?? 0,
});

/** Resolves `{ rid }` lists of an export to their effect instances */
export function effectResolver(refs: UnityRef[]) {
  const byRid = new Map(refs.map((ref) => [ref.rid, ref]));
  return (list: unknown): EffectInstance[] =>
    unwrapArray<{ rid: string }>(list).flatMap((entry) => {
      const ref = byRid.get(entry.rid);
      return ref && ref.type.class === "EffectInstanceDice" ? [effectInstance(ref.data)] : [];
    });
}

/** The JSON exports in a folder, or in its json/ subfolder */
export const findJsonExports = async (dir: string) =>
  Object.fromEntries(
    await Promise.all(
      JSON_EXPORTS.map(async (name) => {
        for (const candidate of [path.join(dir, name), path.join(dir, "json", name)]) {
          if (await fsp.stat(candidate).catch(() => null)) return [name, candidate];
        }
        throw new Error(`${name} not found in ${dir}`);
      }),
    ),
  ) as Record<JsonExport, string>;
