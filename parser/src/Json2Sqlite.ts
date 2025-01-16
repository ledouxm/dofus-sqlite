import fs from "fs/promises";
import sqlite, { Database } from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
type SQLiteType = "TEXT" | "INTEGER" | "NUMERIC" | "BLOB" | "NULL";

interface FieldSchema {
  type: SQLiteType;
  isNullable?: boolean;
  isPrimaryKey?: boolean;
}

interface JunctionTableInfo {
  tableName: string;
  foreignKey: SQLiteType;
  referencedClass?: string;
}

interface TableSchema {
  fields: Record<string, FieldSchema>;
  junctionTables: Record<string, JunctionTableInfo>;
}

interface DatabaseSchema {
  [className: string]: TableSchema;
}

interface TypedReference {
  type: {
    class: string;
  };
  data: Record<string, any>;
}

const TYPE_MAP: Record<string, SQLiteType> = {
  string: "TEXT",
  number: "INTEGER",
  boolean: "INTEGER",
  object: "TEXT",
  array: "TEXT",
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier}"`;
}

function inferSqliteType(value: any): SQLiteType {
  if (value === null || value === undefined) return "TEXT";
  if (Array.isArray(value)) return "TEXT";

  const type = typeof value;
  if (type === "number") {
    return Number.isInteger(value) ? "INTEGER" : "NUMERIC";
  }

  return TYPE_MAP[type] || "TEXT";
}

function isArrayField(value: any): boolean {
  return value && typeof value === "object" && "Array" in value;
}

function analyzeSchema(
  data: Record<string, any>,
  className: string,
): TableSchema {
  const schema: TableSchema = {
    fields: {},
    junctionTables: {},
  };

  // Check if id exists, if not, we'll add UUID
  const hasId = "id" in data;
  schema.fields["id"] = {
    type: hasId ? inferSqliteType(data.id) : "TEXT",
    isPrimaryKey: true,
  };

  const nullableMap = new Set<string>(Object.keys(data));

  for (const [key, value] of Object.entries(data)) {
    if (key === "id") continue;

    if (value) {
      nullableMap.delete(key);
    }

    if (isArrayField(value) && key.endsWith("Ids")) {
      schema.junctionTables[key] = {
        tableName: `${className}_${key}_junction`,
        foreignKey: "TEXT",
      };
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      schema.fields[key] = {
        type: "TEXT",
        isNullable: undefined,
      };
    } else {
      schema.fields[key] = {
        type: inferSqliteType(value),
        isNullable: undefined,
      };
    }
  }

  for (const nullableField of nullableMap) {
    schema.fields[nullableField].isNullable = true;
  }

  return schema;
}

function generateCreateTableSql(
  className: string,
  schema: TableSchema,
): string {
  const quotedTableName = quoteIdentifier(className);

  const columns = Object.entries(schema.fields)
    .map(([fieldName, field]) => {
      const quotedField = quoteIdentifier(fieldName);
      const constraints: any[] = [field.type];

      if (field.isPrimaryKey) {
        constraints.push("NOT NULL PRIMARY KEY");
      }
      if (!field.isNullable) {
        constraints.push("NOT NULL");
      }

      return `${quotedField} ${constraints.join(" ")}`;
    })
    .join(",\n    ");

  let sql = `CREATE TABLE IF NOT EXISTS ${quotedTableName} (\n    ${columns}\n);\n\n`;

  // Generate junction tables
  for (const [fieldName, junction] of Object.entries(schema.junctionTables)) {
    const quotedJunctionTable = quoteIdentifier(junction.tableName);
    const quotedSourceId = quoteIdentifier(`${className}_id`);
    const quotedTargetId = quoteIdentifier(`target_id`);

    sql += `CREATE TABLE IF NOT EXISTS ${quotedJunctionTable} (\n`;
    sql += `    ${quotedSourceId} INTEGER,\n`;
    sql += `    ${quotedTargetId} INTEGER,\n`;
    sql += `    PRIMARY KEY (${quotedSourceId}, ${quotedTargetId}),\n`;
    sql += `    FOREIGN KEY (${quotedSourceId}) REFERENCES ${quotedTableName}("id")\n`;
    sql += `);\n\n`;
  }

  return sql;
}

function generateInsertStatements(className: string, schema: TableSchema) {
  const quotedTableName = quoteIdentifier(className);

  const columns = Object.keys(schema.fields)
    .map((col) => quoteIdentifier(col))
    .join(", ");
  const placeholders = Object.keys(schema.fields)
    .map((k) => `@${k}`)
    .join(", ");

  const mainInsert = `INSERT INTO ${quotedTableName} (${columns}) VALUES (${placeholders})`;

  const junctionInserts: Record<string, string> = {};
  for (const [fieldName, junction] of Object.entries(schema.junctionTables)) {
    const quotedJunctionTable = quoteIdentifier(junction.tableName);
    junctionInserts[fieldName] = `
            INSERT INTO ${quotedJunctionTable} 
            ("${className}_id", "target_id") 
            VALUES (?, ?)
        `;
  }

  return { mainInsert, junctionInserts };
}

function processDataForInsert(data: any, schema: TableSchema): any {
  const processed = { ...data };
  // Generate UUID if no id exists
  if (!processed.id && processed.id !== 0) {
    processed.id = uuidv4();
  }

  // Convert objects to JSON strings
  for (const [key, value] of Object.entries(processed)) {
    if (isArrayField(value) && !key.endsWith("Ids")) {
      processed[key] = JSON.stringify((value as any).Array);
    } else if (typeof value === "object" && value !== null) {
      processed[key] = JSON.stringify(value);
    }
  }

  return processed;
}

async function insertData(
  db: Database,
  className: string,
  schema: TableSchema,
  data: Record<string, any>,
) {
  const statements = generateInsertStatements(className, schema);
  db.transaction(() => {
    const processedData = processDataForInsert(data, schema);
    // Insert main record
    const mainResult = db.prepare(statements.mainInsert).run(processedData);
    const recordId = processedData.id;

    // Insert junction records
    for (const [fieldName, junction] of Object.entries(schema.junctionTables)) {
      if (data[fieldName] && isArrayField(data[fieldName])) {
        const stmt = db.prepare(statements.junctionInserts[fieldName]);
        data[fieldName].Array.forEach((targetId: any) => {
          try {
            stmt.run(recordId, targetId);
          } catch (e) {}
        });
      }
    }
  })();
}

export async function createDatabaseFromJson(
  db: Database,
  jsonPath: string,
): Promise<{ success: boolean; error?: string; schemas?: DatabaseSchema }> {
  try {
    const fileContent = await fs.readFile(jsonPath, "utf8");
    const jsonData = JSON.parse(fileContent).references
      .RefIds as TypedReference[];

    // Group data by class
    const groupedData = new Map<string, TypedReference[]>();
    jsonData.forEach((ref) => {
      if (!ref.type.class) return;
      if (!groupedData.has(ref.type.class)) {
        groupedData.set(ref.type.class, []);
      }
      groupedData.get(ref.type.class)?.push(ref);
    });

    const schemas: DatabaseSchema = {};

    // First pass: analyze schemas
    for (const [className, refs] of groupedData) {
      schemas[className] = analyzeSchema(refs[0].data, className);
    }

    // Second pass: create tables
    for (const [className, schema] of Object.entries(schemas)) {
      const createTableSql = generateCreateTableSql(className, schema);
      createTableSql.split(";").forEach((statement) => {
        if (statement.trim()) {
          db.prepare(statement).run();
        }
      });
    }

    // Third pass: insert data
    let cpt = 0;
    for (const [className, refs] of groupedData) {
      console.log("Inserting", refs.length, "records for", className);
      for (const ref of refs) {
        if (className === "Item") {
          cpt++;
        }

        await insertData(db, className, schemas[className], ref.data);
      }
    }

    return {
      success: true,
      schemas,
    };
  } catch (error) {
    console.log(error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
