import fs from "fs/promises";
import path from "path";
import { Database, Statement } from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
type SQLiteType = "TEXT" | "INTEGER" | "NUMERIC";

interface FieldSchema {
  type: SQLiteType;
  isNullable: boolean;
}

interface TableSchema {
  fields: Record<string, FieldSchema>;
  junctionFields: string[];
}

interface TypedReference {
  type: {
    class: string;
  };
  data: Record<string, any>;
}

// Column added to classes that are stored in more than one file (e.g. SocialRightData
// is used by both guild and alliance rights, with overlapping ids)
const SOURCE_COLUMN = "source";

function quoteIdentifier(identifier: string): string {
  return `"${identifier}"`;
}

function inferSqliteType(value: any): SQLiteType {
  if (typeof value === "number") {
    return Number.isInteger(value) ? "INTEGER" : "NUMERIC";
  }

  return "TEXT";
}

function mergeTypes(a: SQLiteType | undefined, b: SQLiteType): SQLiteType {
  if (!a || a === b) return b;
  if (a !== "TEXT" && b !== "TEXT") return "NUMERIC";
  return "TEXT";
}

function isArrayField(value: any): boolean {
  return !!value && typeof value === "object" && "Array" in value;
}

function isJunctionField(key: string, value: any): boolean {
  return isArrayField(value) && key.endsWith("Ids");
}

// Infers the schema from every record (not just the first one), so a field that is
// null or missing in any record is nullable, and mixed number types widen correctly
function analyzeSchema(records: Record<string, any>[]): TableSchema {
  const types: Record<string, SQLiteType | undefined> = {};
  const nullable = new Set<string>();
  const junctionFields = new Set<string>();
  const allKeys = new Set<string>();

  for (const data of records) {
    for (const key of Object.keys(data)) allKeys.add(key);
  }

  for (const data of records) {
    for (const key of allKeys) {
      const value = data[key];

      if (value === null || value === undefined) {
        nullable.add(key);
        continue;
      }

      if (isJunctionField(key, value)) {
        junctionFields.add(key);
        continue;
      }

      types[key] = mergeTypes(types[key], inferSqliteType(value));
    }
  }

  const fields: Record<string, FieldSchema> = {};

  // Records without an id get a generated UUID
  const allHaveId = records.every((data) => data.id !== null && data.id !== undefined);
  fields["id"] = {
    type: allHaveId ? (types["id"] ?? "TEXT") : "TEXT",
    isNullable: false,
  };

  for (const key of allKeys) {
    if (key === "id" || junctionFields.has(key)) continue;

    fields[key] = {
      type: types[key] ?? "TEXT",
      isNullable: nullable.has(key),
    };
  }

  return { fields, junctionFields: [...junctionFields] };
}

function getJunctionTableName(className: string, fieldName: string) {
  return `${className}_${fieldName}_junction`;
}

function generateCreateTableSql(
  className: string,
  schema: TableSchema,
  hasSource: boolean,
): string[] {
  const quotedTableName = quoteIdentifier(className);

  const columns = Object.entries(schema.fields).map(([fieldName, field]) => {
    const constraints: string[] = [field.type];
    if (!field.isNullable) {
      constraints.push("NOT NULL");
    }
    return `${quoteIdentifier(fieldName)} ${constraints.join(" ")}`;
  });

  if (hasSource) {
    columns.push(`${quoteIdentifier(SOURCE_COLUMN)} TEXT NOT NULL`);
    columns.push(`PRIMARY KEY ("id", ${quoteIdentifier(SOURCE_COLUMN)})`);
  } else {
    columns[0] += " PRIMARY KEY";
  }

  const statements = [
    `CREATE TABLE IF NOT EXISTS ${quotedTableName} (\n    ${columns.join(",\n    ")}\n)`,
  ];

  for (const fieldName of schema.junctionFields) {
    const quotedJunctionTable = quoteIdentifier(getJunctionTableName(className, fieldName));
    const quotedSourceId = quoteIdentifier(`${className}_id`);
    const sourceColumn = hasSource ? `    ${quoteIdentifier(SOURCE_COLUMN)} TEXT NOT NULL,\n` : "";
    const primaryKey = hasSource
      ? `${quotedSourceId}, ${quoteIdentifier(SOURCE_COLUMN)}, "target_id"`
      : `${quotedSourceId}, "target_id"`;

    statements.push(
      `CREATE TABLE IF NOT EXISTS ${quotedJunctionTable} (\n` +
        `    ${quotedSourceId} INTEGER,\n` +
        sourceColumn +
        `    "target_id" INTEGER,\n` +
        `    PRIMARY KEY (${primaryKey})\n` +
        `)`,
    );
  }

  return statements;
}

// When a class spans several files, the table is created by the first one;
// later files may bring fields the first one didn't have
function addMissingColumns(db: Database, className: string, schema: TableSchema) {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${quoteIdentifier(className)})`).all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );

  for (const [fieldName, field] of Object.entries(schema.fields)) {
    if (existing.has(fieldName)) continue;
    db.exec(
      `ALTER TABLE ${quoteIdentifier(className)} ADD COLUMN ${quoteIdentifier(fieldName)} ${field.type}`,
    );
  }
}

function getTableColumns(db: Database, className: string): string[] {
  return (db.prepare(`PRAGMA table_info(${quoteIdentifier(className)})`).all() as { name: string }[]).map(
    (column) => column.name,
  );
}

function processDataForInsert(data: Record<string, any>, columns: string[], source: string | null) {
  const processed: Record<string, any> = {};

  for (const column of columns) {
    if (column === SOURCE_COLUMN && source !== null) {
      processed[column] = source;
      continue;
    }

    const value = data[column];
    if (column === "id" && (value === null || value === undefined)) {
      processed[column] = uuidv4();
    } else if (value === undefined) {
      processed[column] = null;
    } else if (isArrayField(value)) {
      processed[column] = JSON.stringify(value.Array);
    } else if (typeof value === "object" && value !== null) {
      processed[column] = JSON.stringify(value);
    } else if (typeof value === "boolean") {
      processed[column] = value ? 1 : 0;
    } else {
      processed[column] = value;
    }
  }

  return processed;
}

// "guildrightgroupsdata.json" -> "guildrightgroups"
export function getSourceName(jsonPath: string) {
  return path.basename(jsonPath, ".json").replace(/data$/, "");
}

export async function readRefs(jsonPath: string): Promise<TypedReference[]> {
  const fileContent = await fs.readFile(jsonPath, "utf8");
  return JSON.parse(fileContent).references.RefIds as TypedReference[];
}

// Throws on any error: a partially imported file must fail the build instead of
// silently producing a database with missing rows
export async function createDatabaseFromJson(
  db: Database,
  jsonPath: string,
  multiSourceClasses: Set<string>,
) {
  const refs = await readRefs(jsonPath);
  const source = getSourceName(jsonPath);

  // Group data by class
  const groupedData = new Map<string, Record<string, any>[]>();
  for (const ref of refs) {
    if (!ref.type.class) continue;
    if (!groupedData.has(ref.type.class)) {
      groupedData.set(ref.type.class, []);
    }
    groupedData.get(ref.type.class)!.push(ref.data);
  }

  db.transaction(() => {
    for (const [className, records] of groupedData) {
      const hasSource = multiSourceClasses.has(className);
      const schema = analyzeSchema(records);

      for (const statement of generateCreateTableSql(className, schema, hasSource)) {
        db.exec(statement);
      }
      addMissingColumns(db, className, schema);

      const columns = getTableColumns(db, className);
      const mainInsert = db.prepare(
        `INSERT INTO ${quoteIdentifier(className)} (${columns.map(quoteIdentifier).join(", ")}) ` +
          `VALUES (${columns.map((column) => `@${column}`).join(", ")})`,
      );

      const junctionInserts: Record<string, Statement> = {};
      for (const fieldName of schema.junctionFields) {
        const sourceColumns = hasSource ? `, ${quoteIdentifier(SOURCE_COLUMN)}` : "";
        const sourcePlaceholder = hasSource ? ", @source" : "";
        // Duplicate target ids inside one array are ignored, everything else throws
        junctionInserts[fieldName] = db.prepare(
          `INSERT OR IGNORE INTO ${quoteIdentifier(getJunctionTableName(className, fieldName))} ` +
            `("${className}_id"${sourceColumns}, "target_id") VALUES (@id${sourcePlaceholder}, @targetId)`,
        );
      }

      console.log("Inserting", records.length, "records for", className);
      for (const data of records) {
        const processedData = processDataForInsert(data, columns, hasSource ? source : null);
        mainInsert.run(processedData);

        for (const fieldName of schema.junctionFields) {
          if (!isArrayField(data[fieldName])) continue;
          for (const targetId of data[fieldName].Array) {
            junctionInserts[fieldName].run(
              hasSource ? { id: processedData.id, source, targetId } : { id: processedData.id, targetId },
            );
          }
        }
      }
    }
  })();
}
