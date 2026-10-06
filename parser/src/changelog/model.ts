// Entities are reduced to snapshots made of a few kinds of values, so one diff handles every domain
// and its output tells a consumer how to display each change (a text, effect lines, links...).

export const LANGS = ["fr", "en", "de", "es", "pt"] as const;
export type Lang = (typeof LANGS)[number];
export type I18n = Partial<Record<Lang, string>>;

/** Kinds of game objects a change can link to; their names are listed in the changelog's `names` */
export type RefKind =
  | "item"
  | "set"
  | "monster"
  | "spell"
  | "dungeon"
  | "quest"
  | "achievement"
  | "area"
  | "subArea"
  | "worldMap"
  | "itemType"
  | "monsterRace"
  | "questCategory"
  | "achievementCategory"
  | "hintCategory"
  | "job"
  | "title"
  | "ornament"
  | "emote";

/** What opendofusdb needs to format an effect line (see its EffectInstance) */
export interface EffectInstance {
  effectId: number;
  diceNum: number;
  diceSide: number;
  value: number;
  duration: number;
  m_flags: number;
}

export type Scalar = number | string | boolean | null;

export type Value =
  | Scalar
  | { $: "text"; value: I18n }
  | { $: "ref"; ref: RefKind; id: number | null }
  | { $: "refs"; ref: RefKind; ids: number[] }
  /** `keys[i]` pairs lines between versions (see GameVersion.effectKey); not written out */
  | { $: "effects"; lines: EffectInstance[]; keys: string[] }
  | { $: "list"; key: string; ref?: RefKind; entries: Record<string, Value>[] };

export const text = (value: I18n): Value => ({ $: "text", value });
export const ref = (kind: RefKind, id: number | null | undefined): Value => ({
  $: "ref",
  ref: kind,
  id: id === undefined || id === null || id <= 0 ? null : id,
});
export const refs = (kind: RefKind, ids: number[]): Value => ({ $: "refs", ref: kind, ids: [...new Set(ids)] });
export const effects = (lines: EffectInstance[], keys: string[]): Value => ({ $: "effects", lines, keys });
/** Entries are matched between versions by their `key` field, which `ref` names when it is an id */
export const list = (key: string, entries: Record<string, Value>[], kind?: RefKind): Value => ({
  $: "list",
  key,
  ...(kind ? { ref: kind } : {}),
  entries,
});

export interface Entity {
  name: I18n;
  /** Not shown by opendofusdb; undefined when the version has no way to tell (missing column) */
  hidden?: boolean;
  /** Display data that is not compared: icon, category, level range... */
  meta: Record<string, unknown>;
  fields: Record<string, Value>;
}

// ----- Changes, as written to changelog.json -----

export type EffectLine =
  | { change: "added"; new: EffectInstance }
  | { change: "removed"; old: EffectInstance }
  | { change: "changed"; old: EffectInstance; new: EffectInstance };

export type Change =
  | { field: string; kind: "value"; old: Scalar; new: Scalar }
  | { field: string; kind: "text"; old: I18n; new: I18n }
  | { field: string; kind: "ref"; ref: RefKind; old: number | null; new: number | null }
  | { field: string; kind: "refs"; ref: RefKind; added: number[]; removed: number[] }
  | { field: string; kind: "effects"; lines: EffectLine[] }
  | { field: string; kind: "list"; key: string; ref?: RefKind; entries: ListEntryChange[] };

/** Added and removed entries list their fields as changes from or to nothing, so they display like the others */
export type ListEntryChange = {
  key: Scalar;
  /** The entry's name, when it has one (quest steps, achievement objectives...) */
  label?: I18n;
  change: "added" | "removed" | "changed";
  changes: Change[];
};

/** Name of a list entry, from its `name` text field */
const labelOf = (entry: Record<string, Value>) => {
  const name = entry.name;
  return isTagged(name) && name.$ === "text" && Object.keys(name.value).length ? { label: name.value } : {};
};

const isTagged = (value: Value): value is Exclude<Value, Scalar> => typeof value === "object" && value !== null;

const sameText = (a: I18n, b: I18n) => JSON.stringify(a) === JSON.stringify(b);

const sameEffect = (a: EffectInstance, b: EffectInstance) =>
  a.diceNum === b.diceNum && a.diceSide === b.diceSide && a.value === b.value && a.duration === b.duration;

/**
 * Lines with the same key are paired, in order, so "+301 to 350 Vitality" becoming "+320 to 400 Vitality"
 * is one changed line. Output follows the new order, removed lines last.
 */
export function diffEffects(
  oldLines: EffectInstance[],
  oldKeys: string[],
  newLines: EffectInstance[],
  newKeys: string[],
): EffectLine[] {
  const remaining = new Map<string, EffectInstance[]>();
  oldLines.forEach((line, i) => remaining.set(oldKeys[i], [...(remaining.get(oldKeys[i]) ?? []), line]));

  // First pass: lines identical on both sides, wherever they are
  const unmatchedNew: [EffectInstance, string][] = [];
  newLines.forEach((line, i) => {
    const candidates = remaining.get(newKeys[i]) ?? [];
    const same = candidates.findIndex((candidate) => candidate.effectId === line.effectId && sameEffect(candidate, line));
    if (same >= 0) candidates.splice(same, 1);
    else unmatchedNew.push([line, newKeys[i]]);
  });

  const result: EffectLine[] = [];
  for (const [line, key] of unmatchedNew) {
    const old = remaining.get(key)?.shift();
    result.push(old ? { change: "changed", old, new: line } : { change: "added", new: line });
  }
  for (const lines of remaining.values()) for (const old of lines) result.push({ change: "removed", old });
  return result;
}

/** A snapshot value as plain JSON */
export function plain(value: Value): unknown {
  if (!isTagged(value)) return value;
  switch (value.$) {
    case "text":
      return value.value;
    case "ref":
      return value.id;
    case "refs":
      return value.ids;
    case "effects":
      return value.lines;
    case "list":
      return value.entries.map((entry) => plainRecord(entry));
  }
}

export const plainRecord = (record: Record<string, Value>) =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, plain(value)]));

/** The same kind of value, empty: what an added entity or entry is compared with */
function emptyLike(value: Value): Value {
  if (!isTagged(value)) return null;
  switch (value.$) {
    case "text":
      return { $: "text", value: {} };
    case "ref":
      return { ...value, id: null };
    case "refs":
      return { ...value, ids: [] };
    case "effects":
      return { $: "effects", lines: [], keys: [] };
    case "list":
      return { ...value, entries: [] };
  }
}

/** Fields of an added or removed record, as changes from or to nothing */
export function describeRecord(record: Record<string, Value>, change: "added" | "removed", add: RefCollector, skip?: string): Change[] {
  const fields = Object.fromEntries(Object.entries(record).filter(([field]) => field !== skip));
  const empty = Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, emptyLike(value)]));
  return change === "added" ? diffRecord(empty, fields, add) : diffRecord(fields, empty, add);
}

/** Ids found while diffing, by kind, so the changelog can list their names */
export type RefCollector = (kind: RefKind, id: number) => void;

/** Calls `add` for every id a snapshot value links to */
export function collectRefs(value: Value, add: RefCollector): void {
  if (!isTagged(value)) return;
  switch (value.$) {
    case "ref":
      if (value.id !== null) add(value.ref, value.id);
      return;
    case "refs":
      value.ids.forEach((id) => add(value.ref, id));
      return;
    case "list":
      for (const entry of value.entries) {
        const key = entry[value.key];
        if (value.ref && typeof key === "number") add(value.ref, key);
        Object.values(entry).forEach((nested) => collectRefs(nested, add));
      }
      return;
  }
}

function diffValue(field: string, oldValue: Value | undefined, newValue: Value | undefined, add: RefCollector): Change[] {
  oldValue ??= null;
  newValue ??= null;

  if (!isTagged(oldValue) || !isTagged(newValue) || oldValue.$ !== newValue.$) {
    if (!isTagged(oldValue) && !isTagged(newValue)) {
      return oldValue === newValue ? [] : [{ field, kind: "value", old: oldValue, new: newValue }];
    }
    // The kind of value changed between versions (should not happen): report it as plain values
    const before = plain(oldValue);
    const after = plain(newValue);
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [{ field, kind: "value", old: JSON.stringify(before), new: JSON.stringify(after) }];
  }

  switch (newValue.$) {
    case "text": {
      const old = (oldValue as typeof newValue).value;
      return sameText(old, newValue.value) ? [] : [{ field, kind: "text", old, new: newValue.value }];
    }
    case "ref": {
      const old = (oldValue as typeof newValue).id;
      if (old === newValue.id) return [];
      collectRefs(oldValue, add);
      collectRefs(newValue, add);
      return [{ field, kind: "ref", ref: newValue.ref, old, new: newValue.id }];
    }
    case "refs": {
      const oldIds = new Set((oldValue as typeof newValue).ids);
      const newIds = new Set(newValue.ids);
      const added = newValue.ids.filter((id) => !oldIds.has(id));
      const removed = [...oldIds].filter((id) => !newIds.has(id));
      [...added, ...removed].forEach((id) => add(newValue.ref, id));
      return added.length || removed.length ? [{ field, kind: "refs", ref: newValue.ref, added, removed }] : [];
    }
    case "effects": {
      const before = oldValue as typeof newValue;
      const lines = diffEffects(before.lines, before.keys, newValue.lines, newValue.keys);
      return lines.length ? [{ field, kind: "effects", lines }] : [];
    }
    case "list": {
      const entries = diffList(newValue, (oldValue as typeof newValue).entries, add);
      return entries.length
        ? [{ field, kind: "list", key: newValue.key, ...(newValue.ref ? { ref: newValue.ref } : {}), entries }]
        : [];
    }
  }
}

function diffList(newList: Extract<Value, { $: "list" }>, oldEntries: Record<string, Value>[], add: RefCollector) {
  const { key, entries: newEntries } = newList;
  const keyOf = (entry: Record<string, Value>) => JSON.stringify(plain(entry[key] ?? null));
  const oldByKey = new Map(oldEntries.map((entry) => [keyOf(entry), entry]));
  const newKeys = new Set(newEntries.map(keyOf));
  const changes: ListEntryChange[] = [];

  // Only entries that changed link to their object: the changelog lists the names of those alone
  const addKey = (entryKey: Scalar) => {
    if (newList.ref && typeof entryKey === "number") add(newList.ref, entryKey);
  };
  for (const entry of newEntries) {
    const entryKey = plain(entry[key] ?? null) as Scalar;
    const old = oldByKey.get(keyOf(entry));
    if (!old) {
      addKey(entryKey);
      changes.push({ key: entryKey, ...labelOf(entry), change: "added", changes: describeRecord(entry, "added", add, key) });
      continue;
    }
    const entryChanges = diffRecord(old, entry, add);
    if (entryChanges.length) {
      addKey(entryKey);
      changes.push({ key: entryKey, ...labelOf(entry), change: "changed", changes: entryChanges });
    }
  }
  for (const entry of oldEntries) {
    if (newKeys.has(keyOf(entry))) continue;
    const entryKey = plain(entry[key] ?? null) as Scalar;
    addKey(entryKey);
    changes.push({ key: entryKey, ...labelOf(entry), change: "removed", changes: describeRecord(entry, "removed", add, key) });
  }
  return changes;
}

/** Fields missing on one side come from columns an older version lacks: they are not compared */
export function diffRecord(oldRecord: Record<string, Value>, newRecord: Record<string, Value>, add: RefCollector): Change[] {
  const fields = Object.keys(newRecord).filter((field) => field in oldRecord && oldRecord[field] !== undefined && newRecord[field] !== undefined);
  return fields.flatMap((field) => diffValue(field, oldRecord[field], newRecord[field], add));
}
