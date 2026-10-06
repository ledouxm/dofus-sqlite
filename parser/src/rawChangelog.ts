import sqlite, { Database } from "better-sqlite3";
import fs from "fs/promises";
import path from "path";
import { parseArgs } from "util";
import { downloadAsset, resolveReleases } from "./changelog/releases";
import { DeepChange } from "./deepDiff";
import { diffDatabases, Row, Side, TableDiff } from "./dbDiff";

// Table-by-table Markdown diff of two databases, for debugging (see changelog/ for the changelog itself)
// Usage: pnpm changelog:raw [oldTag] [newTag] [--lang en] [--out file.md] [--limit 200]
//        pnpm changelog:raw --old-db a.sqlite --new-db b.sqlite
// Without tags, compares the latest release with the release before it.

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    lang: { type: "string", default: "en" },
    out: { type: "string" },
    limit: { type: "string", default: "200" },
    "max-changes": { type: "string", default: "25" },
    "old-db": { type: "string" },
    "new-db": { type: "string" },
    repo: { type: "string", default: "ledouxm/dofus-sqlite" },
    cache: { type: "string", default: path.join(".cache", "releases") },
  },
});

const LANG = args.lang!;
const LIMIT = Number(args.limit);
const MAX_CHANGES = Number(args["max-changes"]);
const ASSET_NAME = "dofus.sqlite";

// Sections are listed in this order, everything else follows alphabetically
const TABLE_LABELS: Record<string, string> = {
  ItemData: "Items",
  WeaponData: "Weapons",
  ItemSetData: "Item sets",
  RecipeData: "Recipes",
  QuestData: "Quests",
  QuestStepData: "Quest steps",
  AchievementData: "Achievements",
  MonsterData: "Monsters",
  SpellData: "Spells",
  SpellLevelData: "Spell levels",
  DungeonData: "Dungeons",
  SubAreaData: "Sub-areas",
  AreaData: "Areas",
  NpcData: "NPCs",
  MountData: "Mounts",
  CompanionData: "Companions",
  TitleData: "Titles",
  OrnamentData: "Ornaments",
  EmoticonData: "Emotes",
  AlmanaxCalendarData: "Almanax",
  HavenbagFurnitureData: "Havenbag furniture",
  ItemTypeData: "Item types",
  EffectInstanceDice: "Effect instances",
};

const NAME_COLUMNS = [
  "nameId",
  "nameMaleId",
  "resultNameId",
  "shortNameId",
  "titleId",
  "sectorNameId",
  "choiceNameId",
  "descriptionId",
  "messageId",
  "textId",
];

const LEVEL_COLUMNS = ["level", "levelMin", "minLevel", "optimalPlayerLevel", "resultLevel"];

// Columns referencing another table, shown next to an entity's name for context
const REFERENCES: Record<string, Record<string, string>> = {
  ItemData: { typeId: "ItemTypeData" },
  WeaponData: { typeId: "ItemTypeData" },
  RecipeData: { resultTypeId: "ItemTypeData", jobId: "JobData" },
  QuestData: { categoryId: "QuestCategoryData" },
  AchievementData: { categoryId: "AchievementCategoryData" },
  MonsterData: { race: "MonsterRaceData" },
  SubAreaData: { areaId: "AreaData" },
  TitleData: { categoryId: "TitleCategoryData" },
  EffectInstanceDice: { effectId: "EffectData" },
};

class Namer {
  private cache = new Map<string, string | undefined>();
  private columns = new Map<string, Set<string>>();

  constructor(private db: Database) {}

  private tableColumns(side: Side, table: string) {
    const key = `${side}.${table}`;
    if (!this.columns.has(key)) {
      const rows = this.db.prepare(`PRAGMA ${side}.table_info("${table}")`).all() as { name: string }[];
      this.columns.set(key, new Set(rows.map((row) => row.name)));
    }
    return this.columns.get(key)!;
  }

  translate(side: Side, id: unknown) {
    if (id === null || id === undefined || id === "") return undefined;
    const key = `${side}:${id}`;
    if (!this.cache.has(key)) {
      const row = this.db
        .prepare(`SELECT value FROM ${side}.translations WHERE id = CAST(? AS TEXT) AND lang = ?`)
        .get(String(id), LANG) as { value: string } | undefined;
      this.cache.set(key, row?.value?.trim() || undefined);
    }
    return this.cache.get(key);
  }

  name(side: Side, row: Row) {
    for (const column of NAME_COLUMNS) {
      const name = this.translate(side, row[column]);
      if (name) return name;
    }
    return typeof row.adminName === "string" && row.adminName ? row.adminName : undefined;
  }

  referenceName(side: Side, table: string, id: unknown) {
    if (!this.tableColumns(side, table).has("nameId")) return undefined;
    const row = this.db.prepare(`SELECT "nameId" FROM ${side}."${table}" WHERE id = ?`).get(id as number) as
      | Row
      | undefined;
    return row ? this.translate(side, row.nameId) : undefined;
  }

  label(side: Side, table: string, row: Row) {
    const name = this.name(side, row);
    const id = row.id ?? row.resultId;
    const title = name ? `**${escapeMarkdown(name)}**` : undefined;
    const idPart = id !== undefined && id !== null ? `#${id}` : undefined;

    const context: string[] = [];
    const level = LEVEL_COLUMNS.find((column) => typeof row[column] === "number" && (row[column] as number) > 0);
    if (level) context.push(`lvl ${row[level]}`);
    for (const [column, target] of Object.entries(REFERENCES[table] ?? {})) {
      const reference = this.referenceName(side, target, row[column]);
      if (reference) context.push(escapeMarkdown(reference));
    }

    const head = title ? `${title}${idPart ? ` (${idPart})` : ""}` : idPart ?? inlineCode(preview(row));
    return context.length ? `${head} · ${context.join(" · ")}` : head;
  }
}

const escapeMarkdown = (text: string) => text.replace(/([\\*_`<>|[\]])/g, "\\$1").replace(/\s+/g, " ");

const truncate = (text: string, max = 120) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function preview(row: Row) {
  return truncate(
    Object.entries(row)
      .filter(([key, value]) => key !== "id" && value !== null && value !== "" && value !== "[]")
      .slice(0, 6)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(", "),
    100,
  );
}

function formatValue(value: unknown) {
  if (value === undefined) return "∅";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === "" ? '""' : truncate(text);
}

// Inline code spans that survive values containing backticks
const inlineCode = (text: string) => {
  const clean = text.replace(/\s+/g, " ");
  return clean.includes("`") ? `\`\` ${clean} \`\`` : `\`${clean}\``;
};

function formatChanges(changes: DeepChange[]) {
  // Group primitive additions/removals on the same path ("recipeIds: +[1, 2] −[3]")
  const lines: string[] = [];
  const grouped = new Map<string, { added: unknown[]; removed: unknown[] }>();
  const order: (DeepChange | string)[] = [];

  for (const change of changes) {
    const value = change.kind === "added" ? change.new : change.old;
    const isPrimitive = change.kind !== "changed" && (value === null || typeof value !== "object");
    if (!isPrimitive) {
      order.push(change);
      continue;
    }
    if (!grouped.has(change.path)) {
      grouped.set(change.path, { added: [], removed: [] });
      order.push(change.path);
    }
    grouped.get(change.path)![change.kind === "added" ? "added" : "removed"].push(value);
  }

  for (const item of order) {
    if (typeof item === "string") {
      const { added, removed } = grouped.get(item)!;
      const parts = [
        added.length ? `+${inlineCode(truncate(added.join(", ")))}` : "",
        removed.length ? `−${inlineCode(truncate(removed.join(", ")))}` : "",
      ].filter(Boolean);
      lines.push(`${inlineCode(item)}: ${parts.join(" ")}`);
    } else if (item.kind === "changed") {
      lines.push(`${inlineCode(item.path)}: ${inlineCode(formatValue(item.old))} → ${inlineCode(formatValue(item.new))}`);
    } else if (item.kind === "added") {
      lines.push(`${inlineCode(item.path)} added: ${inlineCode(formatValue(item.new))}`);
    } else {
      lines.push(`${inlineCode(item.path)} removed: ${inlineCode(formatValue(item.old))}`);
    }
  }

  if (lines.length > MAX_CHANGES) {
    return [...lines.slice(0, MAX_CHANGES), `… and ${lines.length - MAX_CHANGES} more changes`];
  }
  return lines;
}

function capped<T>(items: T[], render: (item: T) => string) {
  const lines = items.slice(0, LIMIT).map(render);
  if (items.length > LIMIT) lines.push(`- … and ${items.length - LIMIT} more`);
  return lines.join("\n");
}

const details = (summary: string, body: string) =>
  `<details>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`;

const changeCount = (diff: TableDiff) => diff.added.length + diff.removed.length + diff.modified.length;

function renderTable(diff: TableDiff, namer: Namer) {
  const label = TABLE_LABELS[diff.table];
  const title = label ? `${label} (\`${diff.table}\`)` : `\`${diff.table}\``;
  const counts = [
    diff.added.length && `+${diff.added.length}`,
    diff.removed.length && `−${diff.removed.length}`,
    diff.modified.length && `~${diff.modified.length}`,
  ]
    .filter(Boolean)
    .join(" / ");

  const parts = [`### ${title}${counts ? ` — ${counts}` : ""}`];

  if (diff.status !== "changed") {
    parts.push(`_Table ${diff.status} (${diff.status === "added" ? diff.newCount : diff.oldCount} rows)._`);
  }
  if (diff.addedColumns.length) parts.push(`New columns: ${diff.addedColumns.map(inlineCode).join(", ")}`);
  if (diff.removedColumns.length) parts.push(`Removed columns: ${diff.removedColumns.map(inlineCode).join(", ")}`);
  if (diff.status === "changed" && !diff.keyColumns.length) {
    parts.push("_Rows have generated ids, they are compared by content._");
  }

  // Main tables show additions/removals directly, the rest is folded
  const fold = (summary: string, body: string) => (label ? `**${summary}**\n\n${body}` : details(summary, body));

  if (diff.added.length) {
    parts.push(fold(`Added (${diff.added.length})`, capped(diff.added, (row) => `- ${namer.label("main", diff.table, row)}`)));
  }
  if (diff.removed.length) {
    parts.push(fold(`Removed (${diff.removed.length})`, capped(diff.removed, (row) => `- ${namer.label("old", diff.table, row)}`)));
  }
  if (diff.modified.length) {
    const body = capped(diff.modified, (row) =>
      [`- ${namer.label("main", diff.table, row.new)}`, ...formatChanges(row.changes).map((line) => `  - ${line}`)].join("\n"),
    );
    parts.push(details(`Modified (${diff.modified.length})`, body));
  }

  return parts.join("\n\n");
}

function renderTranslations(diff: TableDiff) {
  const langs = [...new Set([...diff.added, ...diff.removed, ...diff.modified.map((row) => row.new)].map((row) => String(row.lang)))].sort();
  const count = (rows: Row[], lang: string) => rows.filter((row) => row.lang === lang).length;

  const summary = [
    "| Lang | Added | Removed | Changed |",
    "|---|---:|---:|---:|",
    ...langs.map(
      (lang) =>
        `| ${lang} | ${count(diff.added, lang)} | ${count(diff.removed, lang)} | ${count(diff.modified.map((row) => row.new), lang)} |`,
    ),
  ].join("\n");

  const text = (value: unknown) => inlineCode(truncate(String(value ?? "")));
  const parts = [`### Texts (\`translations\`)`, summary];
  const added = diff.added.filter((row) => row.lang === LANG);
  const removed = diff.removed.filter((row) => row.lang === LANG);
  const modified = diff.modified.filter((row) => row.new.lang === LANG);

  if (added.length) parts.push(details(`Added ${LANG} texts (${added.length})`, capped(added, (row) => `- #${row.id}: ${text(row.value)}`)));
  if (removed.length) parts.push(details(`Removed ${LANG} texts (${removed.length})`, capped(removed, (row) => `- #${row.id}: ${text(row.value)}`)));
  if (modified.length) {
    parts.push(
      details(
        `Changed ${LANG} texts (${modified.length})`,
        capped(modified, (row) => `- #${row.new.id}: ${text(row.old.value)} → ${text(row.new.value)}`),
      ),
    );
  }
  return parts.join("\n\n");
}

function renderChangelog(diffs: TableDiff[], namer: Namer, oldName: string, newName: string) {
  const changed = diffs.filter((diff) => diff.status !== "changed" || changeCount(diff) || diff.addedColumns.length || diff.removedColumns.length);
  const priority = Object.keys(TABLE_LABELS);
  const rank = (table: string) => (priority.includes(table) ? priority.indexOf(table) : table === "translations" ? Infinity : priority.length);
  changed.sort((a, b) => rank(a.table) - rank(b.table) || a.table.localeCompare(b.table));

  const summaryRows = changed.map(
    (diff) =>
      `| ${TABLE_LABELS[diff.table] ?? diff.table} | ${diff.oldCount} → ${diff.newCount} | ${diff.added.length} | ${diff.removed.length} | ${diff.modified.length} |`,
  );

  return [
    `# Changelog \`${oldName}\` → \`${newName}\``,
    `_Generated on ${new Date().toISOString().slice(0, 10)} · names in \`${LANG}\`._`,
    "## Summary",
    changed.length
      ? ["| Table | Rows | Added | Removed | Modified |", "|---|---|---:|---:|---:|", ...summaryRows].join("\n")
      : "No differences.",
    "## Details",
    ...changed.map((diff) => (diff.table === "translations" ? renderTranslations(diff) : renderTable(diff, namer))),
  ].join("\n\n") + "\n";
}

const main = async () => {
  let oldFile = args["old-db"];
  let newFile = args["new-db"];
  let oldName = oldFile ? path.basename(oldFile) : "";
  let newName = newFile ? path.basename(newFile) : "";

  if (!oldFile || !newFile) {
    const { oldRelease, newRelease } = await resolveReleases(args.repo!, positionals[0], positionals[1]);
    console.log(`Comparing ${oldRelease.tag_name} → ${newRelease.tag_name}`);
    oldFile ??= await downloadAsset(oldRelease, ASSET_NAME, args.cache!);
    newFile ??= await downloadAsset(newRelease, ASSET_NAME, args.cache!);
    oldName = oldRelease.tag_name;
    newName = newRelease.tag_name;
  }

  const db = new sqlite(newFile, { fileMustExist: true });
  db.prepare("ATTACH DATABASE ? AS old").run(path.resolve(oldFile));

  const time = Date.now();
  const diffs = diffDatabases(db, { lang: LANG });
  const markdown = renderChangelog(diffs, new Namer(db), oldName, newName);
  db.close();

  const out = args.out ?? `changelog-${oldName}-${newName}.md`.replace(/[^\w.-]+/g, "_");
  await fs.writeFile(out, markdown);
  console.log(`Changelog written to ${out} in ${Date.now() - time} ms`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
