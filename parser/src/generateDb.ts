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

  const files = await recursiveReadDir(JSON_FOLDER);

  const time = Date.now();
  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    if (file.includes("i18n_")) {
      await generateTranslations(file, db);
    } else {
      await createDatabaseFromJson(db, file);
    }
  }

  console.log("parsed", files.length, "files in", Date.now() - time, "ms");
  db.close();
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

main();
