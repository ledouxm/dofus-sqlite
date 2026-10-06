import { Database } from "better-sqlite3";
import { DeepChange, deepDiff, parseJsonValue } from "./deepDiff";

// Diffs two dofus.sqlite databases: the new one opened as "main", the old one attached as "old".
// Release databases may come from different versions of the generator, so nothing here assumes
// both schemas match: only the columns present on both sides are compared.

export type Side = "old" | "main";
export type Row = Record<string, unknown>;

// path is the column name, followed by the nested path for JSON columns ("grades[grade=3].level")
export type FieldChange = DeepChange;

export interface ModifiedRow {
  old: Row;
  new: Row;
  changes: FieldChange[];
}

export interface TableDiff {
  table: string;
  status: "added" | "removed" | "changed";
  addedColumns: string[];
  removedColumns: string[];
  // Empty when rows have generated UUID ids and are compared by content
  keyColumns: string[];
  added: Row[];
  removed: Row[];
  modified: ModifiedRow[];
  oldCount: number;
  newCount: number;
}

interface Column {
  name: string;
  type: string;
  pk: number;
}

interface Junction {
  table: string;
  field: string;
  hasSource: boolean;
}

interface TableInfo {
  name: string;
  columns: Column[];
  junctions: Junction[];
}

// Rows of these tables have UUID ids that change on every build: pair added/removed rows
// by this key to report them as modifications. Other tables get one detected by findNaturalKey.
const NATURAL_KEYS: Record<string, string[]> = {
  RecipeData: ["resultId"],
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

function readTables(db: Database, side: Side) {
  const names = (
    db.prepare(`SELECT name FROM ${side}.sqlite_master WHERE type = 'table'`).all() as { name: string }[]
  ).map((row) => row.name);

  const tables = new Map<string, TableInfo>();
  for (const name of names) {
    if (name.endsWith("_junction")) continue;
    const columns = db.prepare(`PRAGMA ${side}.table_info(${q(name)})`).all() as Column[];
    tables.set(name, { name, columns, junctions: [] });
  }

  // "ItemData_recipeIds_junction" holds the ItemData.recipeIds array
  for (const name of names) {
    const match = name.match(/^(.+)_([^_]+)_junction$/);
    const parent = match && tables.get(match[1]);
    if (!parent) continue;
    const columns = db.prepare(`PRAGMA ${side}.table_info(${q(name)})`).all() as Column[];
    parent.junctions.push({
      table: name,
      field: match[2],
      hasSource: columns.some((column) => column.name === "source"),
    });
  }

  return tables;
}

const columnNames = (table: TableInfo) => [
  ...table.columns.map((column) => column.name),
  ...table.junctions.map((junction) => junction.field),
];

function hasUuidIds(db: Database, side: Side, table: TableInfo) {
  const id = table.columns.find((column) => column.name === "id");
  if (!id || id.type.toUpperCase() !== "TEXT") return false;
  const row = db.prepare(`SELECT id FROM ${side}.${q(table.name)} LIMIT 1`).get() as { id: unknown } | undefined;
  return typeof row?.id === "string" && UUID_REGEX.test(row.id);
}

// Returns a FROM-able source for the table. Junction arrays are folded back into the row as
// JSON arrays, and key columns are cast when their declared type differs between versions
// (e.g. translations.id went from TEXT to INTEGER) so the join can use an index.
function tableSource(
  db: Database,
  side: Side,
  table: TableInfo,
  keyColumns: string[],
  keyCasts: Record<string, string>,
) {
  if (!table.junctions.length && !Object.keys(keyCasts).length) return `${side}.${q(table.name)}`;

  const parentHasSource = table.columns.some((column) => column.name === "source");
  const selects = table.columns.map((column) =>
    keyCasts[column.name] ? `CAST(t.${q(column.name)} AS ${keyCasts[column.name]}) AS ${q(column.name)}` : `t.${q(column.name)}`,
  );
  for (const junction of table.junctions) {
    const sourceFilter = junction.hasSource && parentHasSource ? ` AND j."source" = t."source"` : "";
    selects.push(
      `(SELECT json_group_array(target_id) FROM (SELECT target_id FROM ${side}.${q(junction.table)} j ` +
        `WHERE j.${q(`${table.name}_id`)} = t."id"${sourceFilter} ORDER BY target_id)) AS ${q(junction.field)}`,
    );
  }

  const temp = q(`${side}_${table.name}`);
  db.exec(`DROP TABLE IF EXISTS temp.${temp}`);
  db.exec(`CREATE TEMP TABLE ${temp} AS SELECT ${selects.join(", ")} FROM ${side}.${q(table.name)} t`);
  if (keyColumns.length) {
    db.exec(`CREATE INDEX temp.${q(`${side}_${table.name}_key`)} ON ${temp} (${keyColumns.map(q).join(", ")})`);
  }
  return `temp.${temp}`;
}

const looselyEqual = (a: unknown, b: unknown) =>
  a === b || (a !== null && b !== null && a !== undefined && b !== undefined && String(a) === String(b));

function splitPrefixed(row: Row, columns: string[]) {
  const oldRow: Row = {};
  const newRow: Row = {};
  for (const column of columns) {
    oldRow[column] = row[`o.${column}`];
    newRow[column] = row[`n.${column}`];
  }
  return { oldRow, newRow };
}

function diffChanges(oldRow: Row, newRow: Row, columns: string[]): FieldChange[] {
  return columns.flatMap((column): FieldChange[] => {
    const oldValue = oldRow[column];
    const newValue = newRow[column];
    if (looselyEqual(oldValue, newValue)) return [];

    const oldJson = parseJsonValue(oldValue);
    const newJson = parseJsonValue(newValue);
    if (oldJson !== undefined && newJson !== undefined) return deepDiff(oldJson, newJson, column);

    return [{ path: column, kind: "changed", old: oldValue, new: newValue }];
  });
}

function diffKeyed(
  db: Database,
  oldSource: string,
  newSource: string,
  keyColumns: string[],
  common: string[],
  oldColumns: string[],
  newColumns: string[],
  lang: string,
): Pick<TableDiff, "added" | "removed" | "modified"> {
  const join = keyColumns.map((column) => `o.${q(column)} = n.${q(column)}`).join(" AND ");

  const added = db
    .prepare(`SELECT ${newColumns.map((c) => `n.${q(c)}`).join(", ")} FROM ${newSource} n WHERE NOT EXISTS (SELECT 1 FROM ${oldSource} o WHERE ${join})`)
    .all() as Row[];
  const removed = db
    .prepare(`SELECT ${oldColumns.map((c) => `o.${q(c)}`).join(", ")} FROM ${oldSource} o WHERE NOT EXISTS (SELECT 1 FROM ${newSource} n WHERE ${join})`)
    .all() as Row[];

  const compared = common.filter((column) => !keyColumns.includes(column));
  const modified = new Map<string, ModifiedRow>();
  const keyOf = (row: Row) => JSON.stringify(keyColumns.map((column) => row[column]));
  const prefixedSelect = [
    ...common.map((c) => `o.${q(c)} AS ${q(`o.${c}`)}`),
    ...common.map((c) => `n.${q(c)} AS ${q(`n.${c}`)}`),
  ].join(", ");

  if (compared.length) {
    const rows = db
      .prepare(
        `SELECT ${prefixedSelect} FROM ${newSource} n JOIN ${oldSource} o ON ${join} ` +
          `WHERE NOT (${compared.map((c) => `o.${q(c)} IS n.${q(c)}`).join(" AND ")})`,
      )
      .all() as Row[];
    for (const row of rows) {
      const { oldRow, newRow } = splitPrefixed(row, common);
      const changes = diffChanges(oldRow, newRow, compared);
      if (changes.length) modified.set(keyOf(newRow), { old: oldRow, new: newRow, changes });
    }
  }

  // An entity can be renamed without its nameId changing: compare the translated names too
  if (common.includes("nameId")) {
    const rows = db
      .prepare(
        `SELECT ${prefixedSelect}, ot.value AS oldName, nt.value AS newName ` +
          `FROM ${newSource} n JOIN ${oldSource} o ON ${join} ` +
          `LEFT JOIN old.translations ot ON ot.id = CAST(o."nameId" AS TEXT) AND ot.lang = @lang ` +
          `LEFT JOIN main.translations nt ON nt.id = CAST(n."nameId" AS TEXT) AND nt.lang = @lang ` +
          `WHERE ot.value IS NOT nt.value`,
      )
      .all({ lang }) as Row[];
    for (const row of rows) {
      const { oldRow, newRow } = splitPrefixed(row, common);
      const key = keyOf(newRow);
      const entry = modified.get(key) ?? { old: oldRow, new: newRow, changes: [] };
      entry.changes.unshift({ path: "name", kind: "changed", old: row.oldName, new: row.newName });
      modified.set(key, entry);
    }
  }

  return { added, removed, modified: [...modified.values()] };
}

// A column whose values are unique and non-null on both sides, sharing the most values between
// them (at least half of the smaller table), e.g. HavenbagFurnitureData.typeId
function findNaturalKey(db: Database, oldSource: string, newSource: string, columns: string[]) {
  const isUnique = (source: string, column: string) => {
    const row = db
      .prepare(`SELECT count(*) AS total, count(DISTINCT ${q(column)}) AS distinctCount, count(${q(column)}) AS nonNull FROM ${source}`)
      .get() as { total: number; distinctCount: number; nonNull: number };
    return row.total > 0 && row.distinctCount === row.total && row.nonNull === row.total;
  };
  const count = (source: string) => (db.prepare(`SELECT count(*) AS count FROM ${source}`).get() as { count: number }).count;
  const minimum = Math.min(count(oldSource), count(newSource)) / 2;

  let best: { column: string; shared: number } | undefined;
  for (const column of columns) {
    if (!isUnique(oldSource, column) || !isUnique(newSource, column)) continue;
    const { shared } = db
      .prepare(`SELECT count(*) AS shared FROM ${newSource} n WHERE n.${q(column)} IN (SELECT ${q(column)} FROM ${oldSource})`)
      .get() as { shared: number };
    if (shared >= minimum && (!best || shared > best.shared)) best = { column, shared };
  }
  return best ? [best.column] : undefined;
}

function diffByContent(
  db: Database,
  table: string,
  oldSource: string,
  newSource: string,
  common: string[],
): Pick<TableDiff, "added" | "removed" | "modified"> {
  const compared = common.filter((column) => column !== "id");
  const select = compared.map(q).join(", ");
  let added = db.prepare(`SELECT ${select} FROM ${newSource} EXCEPT SELECT ${select} FROM ${oldSource}`).all() as Row[];
  let removed = db.prepare(`SELECT ${select} FROM ${oldSource} EXCEPT SELECT ${select} FROM ${newSource}`).all() as Row[];

  if (!added.length || !removed.length) return { added, removed, modified: [] };
  const configuredKey = NATURAL_KEYS[table]?.filter((column) => compared.includes(column));
  const naturalKey = configuredKey?.length ? configuredKey : findNaturalKey(db, oldSource, newSource, compared);
  if (!naturalKey) return { added, removed, modified: [] };

  // Pair rows sharing the same natural key when it is unambiguous on both sides
  const keyOf = (row: Row) => JSON.stringify(naturalKey.map((column) => row[column]));
  const group = (rows: Row[]) => {
    const groups = new Map<string, Row[]>();
    for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
    return groups;
  };
  const addedByKey = group(added);
  const removedByKey = group(removed);
  const modified: ModifiedRow[] = [];
  const paired = new Set<Row>();

  for (const [key, newRows] of addedByKey) {
    const oldRows = removedByKey.get(key);
    if (newRows.length !== 1 || oldRows?.length !== 1) continue;
    modified.push({ old: oldRows[0], new: newRows[0], changes: diffChanges(oldRows[0], newRows[0], compared) });
    paired.add(newRows[0]).add(oldRows[0]);
  }

  added = added.filter((row) => !paired.has(row));
  removed = removed.filter((row) => !paired.has(row));
  return { added, removed, modified };
}

const countRows = (db: Database, side: Side, table: string) =>
  (db.prepare(`SELECT count(*) AS count FROM ${side}.${q(table)}`).get() as { count: number }).count;

export function diffDatabases(db: Database, { lang }: { lang: string }): TableDiff[] {
  const oldTables = readTables(db, "old");
  const newTables = readTables(db, "main");
  const names = [...new Set([...oldTables.keys(), ...newTables.keys()])].sort();
  const diffs: TableDiff[] = [];

  for (const name of names) {
    const oldTable = oldTables.get(name);
    const newTable = newTables.get(name);

    if (!oldTable || !newTable) {
      const side: Side = newTable ? "main" : "old";
      const table = (newTable ?? oldTable)!;
      const rows = db.prepare(`SELECT * FROM ${tableSource(db, side, table, [], {})}`).all() as Row[];
      diffs.push({
        table: name,
        status: newTable ? "added" : "removed",
        addedColumns: [],
        removedColumns: [],
        keyColumns: [],
        added: newTable ? rows : [],
        removed: newTable ? [] : rows,
        modified: [],
        oldCount: newTable ? 0 : rows.length,
        newCount: newTable ? rows.length : 0,
      });
      continue;
    }

    console.log("Comparing", name);
    const oldColumns = columnNames(oldTable);
    const newColumns = columnNames(newTable);
    const common = newColumns.filter((column) => oldColumns.includes(column));

    const byContent = hasUuidIds(db, "main", newTable) || hasUuidIds(db, "old", oldTable);
    const keyColumns = byContent
      ? []
      : newTable.columns
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => column.name)
          .filter((column) => oldColumns.includes(column));

    const keyCasts: Record<string, string> = {};
    for (const key of keyColumns) {
      const oldType = oldTable.columns.find((column) => column.name === key)!.type;
      const newType = newTable.columns.find((column) => column.name === key)!.type;
      if (oldType.toUpperCase() !== newType.toUpperCase()) keyCasts[key] = newType || "TEXT";
    }

    const oldSource = tableSource(db, "old", oldTable, keyColumns, keyCasts);
    const newSource = tableSource(db, "main", newTable, keyColumns, keyCasts);

    const rows = keyColumns.length
      ? diffKeyed(db, oldSource, newSource, keyColumns, common, oldColumns, newColumns, lang)
      : diffByContent(db, name, oldSource, newSource, common);

    diffs.push({
      table: name,
      status: "changed",
      addedColumns: newColumns.filter((column) => !oldColumns.includes(column)),
      removedColumns: oldColumns.filter((column) => !newColumns.includes(column)),
      keyColumns,
      ...rows,
      oldCount: countRows(db, "old", name),
      newCount: countRows(db, "main", name),
    });
  }

  return diffs;
}
