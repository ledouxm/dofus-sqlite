import { Database } from "better-sqlite3";
import path from "path";
import fs from "fs/promises";

export const generateTranslations = async (filePath: string, db: Database) => {
  const lang = path.basename(filePath, ".json").replace("i18n_", "");
  const file = await fs.readFile(filePath, "utf-8");
  const translations = JSON.parse(file);

  db.exec(`
      CREATE TABLE IF NOT EXISTS translations (
      id TEXT,
      value TEXT,
      lang TEXT,
      PRIMARY KEY (id, lang)
      );
  `);

  console.log(
    "Inserting",
    Object.keys(translations).length,
    "translations for lang",
    lang,
  );
  const insert = db.prepare(
    `INSERT INTO translations (id, value, lang) VALUES (?, ?, ?)`,
  );

  db.transaction(() => {
    for (const [key, value] of Object.entries(translations)) {
      insert.run(key, value, lang);
    }
  })();

  console.log("Translations inserted");
};
