import path from "path";
import { createDatabaseFromJson } from "./Json2Sqlite";
import dotenv from "dotenv";
import fs from "fs/promises";
import { generateTranslations } from "./translations";
import sqlite from "better-sqlite3";

dotenv.config();

const OUTPUT_FOLDER = path.join(
  process.env.LOCALAPPDATA!,
  "Ankama",
  "Dofus-dofus3",
  "Dofus_Data",
  "StreamingAssets",
  "Content",
  "output",
);

const main = async () => {
  console.log("### GENERATING DATABASE FROM .JSON FILES");
  const db = new sqlite("./staticDb3");
  db.exec("PRAGMA journal_mode = WAL");

  const files = await fs.readdir(OUTPUT_FOLDER);

  const time = Date.now();

  for (const file of files) {
    if (file.endsWith(".json")) {
      console.log("parsing", file);
      const resp = await createDatabaseFromJson(
        db,
        path.join(OUTPUT_FOLDER, file),
      );
    }
  }

  console.log("parsed", files.length, "files in", Date.now() - time, "ms");

  await generateTranslations("fr", db);
};

main();
