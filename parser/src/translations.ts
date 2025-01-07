import { Database } from "better-sqlite3";
import path from "path";
import fs from "fs/promises";
import { fetchFileFromLatestRelease } from "./github";

const safeReadFile = async (filePath: string) => {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    return null;
  }
};

const safeFileExists = async (filePath: string) => {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
};

export const generateTranslations = async (lang: string, db: Database) => {
  const outputFile = `${lang}.i18n.json`;

  const fileExists = await safeFileExists(outputFile);

  const file = fileExists
    ? (await safeReadFile(outputFile))!
    : await fetchFileFromLatestRelease({
        owner: "dofusdude",
        repo: "dofus3-lang-main",
        fileName: "fr.i18n.json",
      });

  if (!fileExists) {
    await fs.writeFile(outputFile, file);
  }

  const translations = JSON.parse(file).entries;

  db.exec(`
      CREATE TABLE IF NOT EXISTS translations (
      id TEXT PRIMARY KEY,
      value TEXT,
      lang TEXT
      );
  `);

  console.log("Inserting", Object.keys(translations).length, "translations");
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
