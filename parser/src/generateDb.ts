import path from "path";
import { createDatabaseFromJson } from "./Json2Sqlite";
import dotenv from "dotenv";
import fs from "fs/promises";
import { generateTranslations } from "./translations";
import sqlite from "better-sqlite3";

dotenv.config();

const JSON_FOLDER =
  process.env.JSON_FOLDER ??
  path.join(
    process.env.LOCALAPPDATA!,
    "Ankama",
    "Dofus-dofus3",
    "Dofus_Data",
    "StreamingAssets",
    "Content",
    "output",
  );

const DATABASE_URL = process.env.DATABASE_URL ?? "dofus.sqlite";

const safeRm = async (file: string) => {
  try {
    await fs.rm(file, {
      force: true,
    });
  } catch (e) {
    console.error(e);
  }
};

const main = async () => {
  console.log("### GENERATING DATABASE FROM .JSON FILES");
  await safeRm(DATABASE_URL);

  const db = new sqlite(DATABASE_URL);
  db.exec("PRAGMA journal_mode = WAL");

  // Map bundles are parsed into maps.sqlite, they must not end up in dofus.sqlite
  const files = (await recursiveReadDir(JSON_FOLDER)).filter(
    (file) => file.endsWith(".json") && !path.basename(file).startsWith("mapdata_"),
  );
  const dataFiles = files.filter((file) => !path.basename(file).startsWith("i18n_"));

  const time = Date.now();
  const multiSourceClasses = await findMultiSourceClasses(dataFiles);
  if (multiSourceClasses.size) {
    console.log("classes stored in several files:", [...multiSourceClasses].join(", "));
  }

  for (const file of files) {
    if (path.basename(file).startsWith("i18n_")) {
      await generateTranslations(file, db);
    } else {
      await createDatabaseFromJson(db, file, multiSourceClasses);
    }
  }

  console.log("parsed", files.length, "files in", Date.now() - time, "ms");
  db.close();
};

// Cheap pre-pass (no JSON parsing) to know which classes need a "source" column
// before their table is created
const findMultiSourceClasses = async (files: string[]) => {
  const classFiles = new Map<string, Set<string>>();

  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    for (const match of content.matchAll(/"class":\s*"([^"]+)"/g)) {
      if (!classFiles.has(match[1])) classFiles.set(match[1], new Set());
      classFiles.get(match[1])!.add(file);
    }
  }

  return new Set([...classFiles].filter(([, files]) => files.size > 1).map(([className]) => className));
};

const recursiveReadDir = async (dir: string): Promise<string[]> => {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    dirents.map((dirent) => {
      const res = path.resolve(dir, dirent.name);
      return dirent.isDirectory() ? recursiveReadDir(res) : res;
    }),
  );
  return Array.prototype.concat(...files);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
