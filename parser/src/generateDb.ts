import path from "path";
import { createDatabaseFromJson } from "./Json2Sqlite";
import dotenv from "dotenv";
import fs from "fs/promises";
import { generateTranslations } from "./translations";
import sqlite from "better-sqlite3";

dotenv.config();

const JSON_FOLDER = (process.env.JSON_FOLDER = path.join(
  process.env.LOCALAPPDATA!,
  "Ankama",
  "Dofus-dofus3",
  "Dofus_Data",
  "StreamingAssets",
  "Content",
  "output",
));

const DATABASE_URL = process.env.DATABASE_URL ?? "dofus.sqlite";

const main = async () => {
  console.log("### GENERATING DATABASE FROM .JSON FILES");
  const db = new sqlite(DATABASE_URL);
  db.exec("PRAGMA journal_mode = WAL");

  const files = await fs.readdir(JSON_FOLDER);

  const time = Date.now();

  for (const file of files) {
    if (file.endsWith(".json")) {
      console.log("parsing", file);
      const resp = await createDatabaseFromJson(
        db,
        path.join(JSON_FOLDER, file),
      );
    }
  }

  console.log("parsed", files.length, "files in", Date.now() - time, "ms");

  await generateTranslations("fr", db);
};

main();
