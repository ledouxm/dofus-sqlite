import { DOMAINS, Domain, EXTRACTORS, refName } from "./domains";
import { Change, EffectInstance, Entity, I18n, RefKind, describeRecord, diffRecord } from "./model";
import { GameVersion } from "./version";

export const SCHEMA_VERSION = 1;

export interface ChangelogEntry {
  domain: Domain;
  id: number;
  change: "added" | "removed" | "changed";
  name: I18n;
  meta: Record<string, unknown>;
  /** What changed; for an added or removed entity, every field as a change from or to nothing */
  changes: Change[];
}

interface Summary {
  added: number;
  removed: number;
  changed: number;
}

export interface Changelog {
  schemaVersion: number;
  from: string;
  to: string;
  generatedAt: string;
  summary: Partial<Record<Domain, Summary & { byCategory?: Record<string, Summary> }>>;
  entries: ChangelogEntry[];
  /** Names of every object the entries link to, in the new version (the old one for removed objects) */
  names: Partial<Record<RefKind, Record<string, I18n>>>;
}

export interface FirstSeen {
  schemaVersion: number;
  release: string;
  /** Release tag an entity first appeared in, null when it was there before the first tracked release */
  firstSeen: Partial<Record<Domain, Record<string, string | null>>>;
}

function diffDomain(domain: Domain, oldEntities: Map<number, Entity>, newEntities: Map<number, Entity>, addRef: (kind: RefKind, id: number) => void) {
  const entries: ChangelogEntry[] = [];
  const ids = [...new Set([...newEntities.keys(), ...oldEntities.keys()])].sort((a, b) => a - b);

  for (const id of ids) {
    let before = oldEntities.get(id);
    let after = newEntities.get(id);
    // Hidden entities are left out, as in opendofusdb; a version that cannot tell borrows the other's answer
    if (before && (before.hidden ?? after?.hidden)) before = undefined;
    if (after && (after.hidden ?? oldEntities.get(id)?.hidden)) after = undefined;
    if (!before && !after) continue;
    const base = { domain, id };

    if (!before || !after) {
      const entity = (after ?? before)!;
      const change = after ? "added" : "removed";
      entries.push({ ...base, change, name: entity.name, meta: entity.meta, changes: describeRecord(entity.fields, change, addRef, "name") });
      continue;
    }

    const changes = diffRecord(before.fields, after.fields, addRef);
    if (changes.length) entries.push({ ...base, change: "changed", name: after.name, meta: after.meta, changes });
  }
  return entries;
}

const EFFECT_REF_KINDS: RefKind[] = ["spell", "monster", "item"];

function* effectInstances(entries: ChangelogEntry[]): Generator<EffectInstance> {
  const visit = function* (changes: Change[]): Generator<EffectInstance> {
    for (const change of changes) {
      if (change.kind === "effects") {
        for (const line of change.lines) {
          if ("old" in line) yield line.old;
          if ("new" in line) yield line.new;
        }
      }
      if (change.kind === "list") for (const entry of change.entries) yield* visit(entry.changes);
    }
  };
  for (const entry of entries) yield* visit(entry.changes);
}

const summarize = (entries: ChangelogEntry[]): Summary => ({
  added: entries.filter((entry) => entry.change === "added").length,
  removed: entries.filter((entry) => entry.change === "removed").length,
  changed: entries.filter((entry) => entry.change === "changed").length,
});

export function generate(oldVersion: GameVersion, newVersion: GameVersion, previousFirstSeen?: FirstSeen) {
  const referenced = new Map<RefKind, Set<number>>();
  const addRef = (kind: RefKind, id: number) => {
    if (!referenced.has(kind)) referenced.set(kind, new Set());
    referenced.get(kind)!.add(id);
  };

  const changelog: Changelog = {
    schemaVersion: SCHEMA_VERSION,
    from: oldVersion.tag,
    to: newVersion.tag,
    generatedAt: new Date().toISOString(),
    summary: {},
    entries: [],
    names: {},
  };
  const firstSeen: FirstSeen = { schemaVersion: SCHEMA_VERSION, release: newVersion.tag, firstSeen: structuredClone(previousFirstSeen?.firstSeen ?? {}) };

  for (const domain of DOMAINS) {
    const time = Date.now();
    const oldEntities = EXTRACTORS[domain](oldVersion);
    const newEntities = EXTRACTORS[domain](newVersion);
    const entries = diffDomain(domain, oldEntities, newEntities, addRef);
    changelog.entries.push(...entries);

    changelog.summary[domain] = summarize(entries);
    if (domain === "item") {
      const categories = [...new Set(entries.map((entry) => entry.meta.category as string))].sort();
      changelog.summary[domain]!.byCategory = Object.fromEntries(
        categories.map((category) => [category, summarize(entries.filter((entry) => entry.meta.category === category))]),
      );
    }

    // Entities already shown when tracking started have no known first release
    const seen = (firstSeen.firstSeen[domain] ??= {});
    const addedIds = new Set(entries.filter((entry) => entry.change === "added").map((entry) => entry.id));
    for (const [id, entity] of newEntities) {
      if (id in seen || (entity.hidden ?? oldEntities.get(id)?.hidden)) continue;
      seen[id] = addedIds.has(id) ? newVersion.tag : null;
    }

    const { added, removed, changed } = changelog.summary[domain]!;
    console.log(`${domain}: +${added} -${removed} ~${changed} (${newEntities.size} total, ${Date.now() - time} ms)`);
  }

  for (const [kind, ids] of referenced) {
    const names: Record<string, I18n> = {};
    for (const id of [...ids].sort((a, b) => a - b)) {
      const name = refName(newVersion, kind, id);
      names[id] = Object.keys(name).length ? name : refName(oldVersion, kind, id);
    }
    changelog.names[kind] = names;
  }

  // Effects name a spell, monster or item through one of their parameters (which one is up to the consumer):
  // their names are listed too, so a line about something removed since still reads
  for (const effect of effectInstances(changelog.entries)) {
    if (!oldVersion.effectKey(effect).includes(":")) continue;
    for (const id of new Set([effect.diceNum, effect.diceSide, effect.value])) {
      if (id <= 0) continue;
      for (const kind of EFFECT_REF_KINDS) {
        const names = (changelog.names[kind] ??= {});
        if (id in names) continue;
        const name = refName(newVersion, kind, id);
        const found = Object.keys(name).length ? name : refName(oldVersion, kind, id);
        if (Object.keys(found).length) names[id] = found;
      }
    }
  }

  return { changelog, firstSeen };
}
