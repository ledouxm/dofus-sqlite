# dofus-sqlite

> Up to date Dofus 3 data, automatically extracted and packaged into convenient SQLite databases — updated every hour.

## Release assets

Each release contains the following files:

| File | Description |
|---|---|
| `dofus.sqlite` | Full game database — quests, achievements, items, map positions, i18n, and more |
| `maps.sqlite` | Map interactions database — interactable elements and their positions per map |
| `dofus.proto` | Obfuscated Protobuf definition extracted from the game binary |
| `*.json` | Raw JSON files for every data class, one file per type |

## How to use

1. Go to the [Releases](../../releases) page
2. Download the latest `dofus.sqlite` (and optionally `maps.sqlite`) file
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
  .where("translations.lang", "=", "fr")
  .select(["translations.value as name"])
  .selectAll(["Recipes"])
  .execute();
```

## How the pipeline works

Releases are produced by 3 GitHub Actions workflows that chain together automatically. The data and map jobs run in parallel to cut down total release time:

```
┌──────────────────────────────────────────┐
│  1 - Check Version & Create Pre-release  │  ← hourly schedule, push to development,
│            ubuntu-latest                 │    or manual dispatch
└─────────────────┬────────────────────────┘
                  │  creates pre-release, passes tag via artifact
         ┌────────┴────────┐
         ▼                 ▼        (run in parallel)
┌────────────────┐  ┌──────────────────┐
│  2 - Data      │  │  3 - Maps        │
│  windows       │  │  windows         │
└────────────────┘  └──────────────────┘
```

**Pipeline 1** checks the current Dofus 3 version via [cytrus-v6](https://www.npmjs.com/package/cytrus-v6). If the version changed (or the run was triggered manually or by a push to `development`), it creates a pre-release and publishes a `release-tag` artifact consumed by the next two pipelines.

- **Scheduled / manual** → compares against the latest non-prerelease; creates a standard pre-release
- **Push to `development`** → always runs; creates a draft pre-release with a timestamp suffix

**Pipeline 2** runs on Windows and downloads everything except map bundles:

1. `Data/**/*.bundle` + `I18n/*.bin` + `GameAssembly.dll` + `global-metadata.dat`
2. Parses bundles to JSON (`pnpm extract`)
3. Generates `dofus.sqlite` (`pnpm db`)
4. Runs `Il2CppDumper.exe` then `protodec.exe` → `dofus.proto`
5. Uploads all output files flat to the pre-release

**Pipeline 3** runs on Windows in parallel and handles maps only:

1. `Map/Data/**/*.bundle`
2. Parses map interactions → `maps.sqlite` (`pnpm extract` with `MAP_INTERACTIONS_DB=maps.sqlite`)
3. Uploads `maps.sqlite` flat to the pre-release

Each pipeline also supports `workflow_dispatch` with a `release_tag` input so you can re-populate an existing pre-release without re-running the version check.

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

1. First executes `pnpm extract` to convert game files to readable .json files
2. Then runs `pnpm db` to generate a .sqlite file from .json files

### Running the pipeline locally

Use `run-local.ps1` to replicate the full CI pipeline on your machine:

```powershell
# Full pipeline (download → parse → db → proto)
.\run-local.ps1

# Skip download, re-parse and regenerate databases from existing temp/
.\run-local.ps1 -SkipDownload

# Skip download and parse, only regenerate databases from existing json/
.\run-local.ps1 -SkipDownload -SkipParse

# Skip everything except proto generation
.\run-local.ps1 -SkipDownload -SkipParse -SkipDatabase

# Create a GitHub release after the pipeline (requires GH_TOKEN)
.\run-local.ps1 -CreateRelease -ReleaseTag my-test
```
