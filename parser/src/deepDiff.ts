// Structural diff of the JSON stored in columns (grades, drops, criterions arrays, folded junction ids...)
// so a changelog says "grades[grade=3].lifePoints: 90 → 110" instead of dumping two 5KB blobs.

// Internal ids renumbered between builds, they never reflect a game change: Unity
// SerializeReference ids (also rounded, they exceed 2^53) and monster drop row ids
const IGNORED_KEYS = new Set(["rid", "dropId"]);

export interface DeepChange {
  path: string;
  kind: "changed" | "added" | "removed";
  old?: unknown;
  new?: unknown;
}

// Keys that can identify an element inside an array of objects (first one wins ties). A key is
// only a candidate when every element on both sides has a distinct value for it.
const IDENTITY_KEYS = [
  "id",
  "grade",
  "objectId",
  "itemId",
  "spellId",
  "effectId",
  "monsterId",
  "npcId",
  "mapId",
  "subAreaId",
  "questId",
  "achievementId",
  "typeId",
];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPrimitive = (value: unknown) => value === null || typeof value !== "object";

// Unity serializes arrays as { "Array": [...] }
const unwrap = (value: unknown): unknown =>
  isObject(value) && Object.keys(value).length === 1 && Array.isArray(value.Array) ? value.Array : value;

export function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

const join = (path: string, key: string) => (path ? `${path}.${key}` : key);

function identityKey(oldArray: unknown[], newArray: unknown[]) {
  const all = [...oldArray, ...newArray];
  if (!all.length || !all.every(isObject)) return undefined;

  const uniqueValues = (array: unknown[], key: string) => {
    const values = array.map((element) => (element as Record<string, unknown>)[key]);
    const isUnique = values.every((value) => isPrimitive(value) && value != null) && new Set(values).size === values.length;
    return isUnique ? new Set(values) : undefined;
  };

  // Some ids get renumbered between versions (e.g. drops[].dropId while objectId stays):
  // keep the candidate matching the most elements across both sides
  let best: { key: string; matches: number } | undefined;
  for (const key of IDENTITY_KEYS) {
    const oldValues = uniqueValues(oldArray, key);
    const newValues = uniqueValues(newArray, key);
    if (!oldValues || !newValues) continue;
    const matches = [...newValues].filter((value) => oldValues.has(value)).length;
    if (!best || matches > best.matches) best = { key, matches };
  }
  return best?.key;
}

function diffPrimitiveArrays(path: string, oldArray: unknown[], newArray: unknown[]): DeepChange[] {
  // Multiset difference: order changes alone are not reported
  const count = (array: unknown[]) => {
    const counts = new Map<string, number>();
    for (const value of array) counts.set(JSON.stringify(value), (counts.get(JSON.stringify(value)) ?? 0) + 1);
    return counts;
  };
  const oldCounts = count(oldArray);
  const newCounts = count(newArray);
  const changes: DeepChange[] = [];

  for (const [value, n] of newCounts) {
    for (let i = (oldCounts.get(value) ?? 0); i < n; i++) changes.push({ path, kind: "added", new: JSON.parse(value) });
  }
  for (const [value, n] of oldCounts) {
    for (let i = (newCounts.get(value) ?? 0); i < n; i++) changes.push({ path, kind: "removed", old: JSON.parse(value) });
  }
  return changes;
}

const canonical = (value: unknown) =>
  JSON.stringify(value, (key, nested) => (IGNORED_KEYS.has(key) ? undefined : unwrap(nested)));

const leafCount = (value: unknown): number => {
  value = unwrap(value);
  if (Array.isArray(value)) return value.reduce((sum: number, element) => sum + leafCount(element), 0);
  if (isObject(value)) return Object.values(value).reduce((sum: number, nested) => sum + leafCount(nested), 0);
  return 1;
};

// Arrays of objects without an identity key (e.g. resourcesBySubarea tuples): elements present on
// both sides are ignored wherever they moved, then leftovers are paired with their closest match so
// an insertion doesn't shift every following element
function diffUnkeyedArrays(path: string, oldArray: unknown[], newArray: unknown[]): DeepChange[] {
  const oldLeft = oldArray.map((value, index) => ({ value, index, key: canonical(value) }));
  const newLeft: typeof oldLeft = [];

  for (const [index, value] of newArray.entries()) {
    const key = canonical(value);
    const match = oldLeft.findIndex((element) => element.key === key);
    if (match >= 0) oldLeft.splice(match, 1);
    else newLeft.push({ value, index, key });
  }

  const changes: DeepChange[] = [];
  for (const element of newLeft) {
    const elementPath = `${path}[${element.index}]`;
    let best: { at: number; shared: number; total: number; changes: DeepChange[] } | undefined;
    for (const [at, candidate] of oldLeft.entries()) {
      const candidateChanges = deepDiff(candidate.value, element.value, elementPath);
      // Leaves of the old element that survive in the new one
      const total = leafCount(candidate.value);
      const lost = candidateChanges.reduce(
        (sum, change) => sum + (change.kind === "changed" ? 1 : change.kind === "removed" ? leafCount(change.old) : 0),
        0,
      );
      const shared = total - lost;
      if (!best || shared / total > best.shared / best.total) best = { at, shared, total, changes: candidateChanges };
    }

    // Only pair elements that are mostly alike, otherwise it's an addition plus a removal
    if (best && best.shared > 0 && best.shared >= best.total / 2) {
      changes.push(...best.changes);
      oldLeft.splice(best.at, 1);
    } else {
      changes.push({ path: elementPath, kind: "added", new: element.value });
    }
  }
  for (const element of oldLeft) {
    changes.push({ path: `${path}[${element.index}]`, kind: "removed", old: element.value });
  }
  return changes;
}

function diffArrays(path: string, oldArray: unknown[], newArray: unknown[]): DeepChange[] {
  if ([...oldArray, ...newArray].every(isPrimitive)) return diffPrimitiveArrays(path, oldArray, newArray);

  const key = identityKey(oldArray, newArray);
  if (!key) {
    // No identity: compare position by position
    return diffUnkeyedArrays(path, oldArray, newArray);
  }

  const byKey = (array: unknown[]) =>
    new Map(array.map((element) => [String((element as Record<string, unknown>)[key]), element]));
  const oldByKey = byKey(oldArray);
  const newByKey = byKey(newArray);
  const changes: DeepChange[] = [];

  for (const [id, element] of newByKey) {
    const elementPath = `${path}[${key}=${id}]`;
    if (!oldByKey.has(id)) changes.push({ path: elementPath, kind: "added", new: element });
    else changes.push(...deepDiff(oldByKey.get(id), element, elementPath));
  }
  for (const [id, element] of oldByKey) {
    if (!newByKey.has(id)) changes.push({ path: `${path}[${key}=${id}]`, kind: "removed", old: element });
  }
  return changes;
}

export function deepDiff(oldValue: unknown, newValue: unknown, path = ""): DeepChange[] {
  oldValue = unwrap(oldValue);
  newValue = unwrap(newValue);

  if (Array.isArray(oldValue) && Array.isArray(newValue)) return diffArrays(path, oldValue, newValue);

  if (isObject(oldValue) && isObject(newValue)) {
    const changes: DeepChange[] = [];
    for (const key of new Set([...Object.keys(oldValue), ...Object.keys(newValue)])) {
      if (IGNORED_KEYS.has(key)) continue;
      if (!(key in oldValue)) changes.push({ path: join(path, key), kind: "added", new: newValue[key] });
      else if (!(key in newValue)) changes.push({ path: join(path, key), kind: "removed", old: oldValue[key] });
      else changes.push(...deepDiff(oldValue[key], newValue[key], join(path, key)));
    }
    return changes;
  }

  if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return [];
  return [{ path, kind: "changed", old: oldValue, new: newValue }];
}
