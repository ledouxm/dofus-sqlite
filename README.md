# Dofus-sqlite

👨‍💻 **Up to date Dofus 3 data, in a convenient SQLite database**

## How to use

1. Go to the [Releases](../../releases) page
2. Download the latest `dofus.sqlite` file
3. That's it! The database is ready to use

_Note: This repo contains the extraction code that creates these releases. If you just want the data, you don't need to clone this repository._

## Usage with [kysely](https://github.com/kysely-org/kysely)

1. Install dependencies

```bash
pnpm i kysely better-sqlite3
pnpm i -D kysely-codegen @types/better-sqlite3
```

2. Pull TS types from database

```bash
kysely-codegen --dialect sqlite --url /path/to/dofus.sqlite --out-file /path/to/dofus.d.ts
```

3. Enjoy full type-safety

```ts
import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { DB } from "/path/to/dofus.d.ts";

const database = new SQLite("/path/to/dofus.sqlite");
const dialect = new SqliteDialect({ database });

const db = new Kysely<DB>({ dialect });

const potionRecipes = await db
  .selectFrom("Items")
  .innerJoin("Recipes", "Recipes.resultId", "Items.id")
  .innerJoin("translations", "Items.nameId", "translations.id")
  .where("translations.value", "like", "%potion%")
  .select(["translations.value as name"])
  .selectAll(["Recipes"])
  .execute();
```

## Developer Instructions

### Prerequisites

- [pnpm](https://pnpm.io/installation)
- Node.js v20
- dotnet v7

### Setup

```bash
pnpm install
```

Copy the .env.dist file to a .env and fill your Dofus folder path

### Available Scripts

1. First executes `pnpm extract` to get convert game files to readable .json files
2. Then runs `pnpm db` to generate a .sqlite file from .json files
