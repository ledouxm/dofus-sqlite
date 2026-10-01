import { Database } from "better-sqlite3";
import path from "path";
import fs from "fs/promises";

export const generateTranslations = async (filePath: string, db: Database) => {
  const lang = path.basename(filePath, ".json").replace("i18n_", "");
  const file = await fs.readFile(filePath, "utf-8");
  const translations = JSON.parse(file);

  // id is an INTEGER so joins against the *Id columns (all INTEGER) can use the index
  db.exec(`
      CREATE TABLE IF NOT EXISTS translations (
      id INTEGER NOT NULL,
      value TEXT,
      lang TEXT NOT NULL,
      PRIMARY KEY (id, lang)
      ) WITHOUT ROWID;
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
      insert.run(Number(key), value, lang);
    }
  })();

  console.log("Translations inserted");
};
