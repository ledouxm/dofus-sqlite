import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { DB } from "./dofus.d.ts";

const database = new SQLite("../../parser/dofus.sqlite");
const dialect = new SqliteDialect({ database });

const db = new Kysely<DB>({ dialect });

db.selectFrom("Items")
  .innerJoin("Recipes", "Recipes.resultId", "Items.id")
  .innerJoin("translations", "Items.nameId", "translations.id")
  .select(["translations.value as name"])
  .selectAll(["Recipes"])
  .where("translations.value", "like", "%potion%")
  .execute()
  .then((data) => {
    console.log(data);
  });
