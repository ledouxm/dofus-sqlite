import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { DB } from "./dofus.d.ts";

const database = new SQLite("../../parser/dofus.sqlite");
const dialect = new SqliteDialect({ database });

const db = new Kysely<DB>({ dialect });

db.selectFrom("ItemData")
  .innerJoin("RecipeData", "RecipeData.resultId", "ItemData.id")
  .innerJoin("translations", "ItemData.nameId", "translations.id")
  .select(["translations.value as name"])
  .selectAll(["RecipeData"])
  .where("translations.value", "like", "%potion%")
  .where("translations.lang", "=", "fr")
  .execute()
  .then((data) => {
    console.log(data);
  });
