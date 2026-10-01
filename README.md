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
| `images-<category>.zip` | Game images as PNG, one zip per category (`item`, `monster`, `spell`, `emblem`, `worldmap`, ...) |

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
  .selectFrom("ItemData")
  .innerJoin("RecipeData", "RecipeData.resultId", "ItemData.id")
  .innerJoin("translations", "ItemData.nameId", "translations.id")
  .where("translations.value", "like", "%potion%")
  .where("translations.lang", "=", "fr")
  .select(["translations.value as name"])
  .selectAll(["RecipeData"])
  .execute();
```

Tables are named after the game's data classes (`ItemData`, `RecipeData`, `MonsterData`, ...). Every `*NameId` / `*DescriptionId` column joins on `translations.id` (an `INTEGER`), filtered by `translations.lang` (`fr`, `en`, `es`, `de`, `pt`).

A few classes are shared by several game files and get an extra `source` column (part of the primary key) telling which file a row comes from, e.g. `SocialRightData.source` is `guildrightgroups` or `alliancerightgroups`.

## Images

Each `images-<category>.zip` holds the PNGs of one category. When the game provides two resolutions, they sit in `1x/` and `2x/` folders. Paths follow the game's own asset paths where it has them, e.g. `images-emblem.zip` contains `big/up/2x/98.png` (each emblem layer: `up`, `backcontent`, `outlineguild`, `outlinealliance`).

Most images can be joined to the database by their file name:

| Zip | File name | Database column |
|---|---|---|
| `images-item.zip` | `1x/<id>.png`, `2x/<id>.png` | `ItemData.iconId` |
| `images-monster.zip` | `1x/<id>.png`, `2x/<id>.png` | `MonsterData.gfxId` |
| `images-spell.zip` | `1x/sort_<id>.png`, `2x/sort_<id>.png` | `SpellData.iconId` |

A few bundles only name their textures, with several textures sharing a name. Those get the size, then an index, appended: `10_668x400.png`, `10_1024x1024_3.png`. World maps are exported as the tiles the game stores (one name per world map), not as assembled maps.

## How the pipeline works

Releases are produced by 2 GitHub Actions workflows that chain together automatically:

```
┌──────────────────────────────────────────┐
│  1 - Check Version & Create Pre-release  │  ← hourly schedule, push to development,
│            ubuntu-latest                 │    or manual dispatch
└─────────────────┬────────────────────────┘
                  │  creates pre-release, passes tag via artifact
                  ▼
┌──────────────────────────────────────────┐
│  2 - Populate Release: setup (windows)   │  downloads game files once, shares them as artifacts
└─────────────────┬────────────────────────┘
       ┌──────────┼───────────┬────────────┐      (run in parallel)
       ▼          ▼           ▼            ▼
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│  data    │ │  proto   │ │  maps    │ │  images  │
│  windows │ │  windows │ │  windows │ │  ubuntu  │
└────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘
     └────────────┴─────┬──────┴────────────┘
                        ▼
              promote to full release
```

**Workflow 1** checks the current Dofus 3 version via [cytrus-v6](https://www.npmjs.com/package/cytrus-v6). If the version changed (or the run was triggered manually or by a push to `development`), it creates a pre-release and publishes a `release-tag` artifact consumed by workflow 2.

- **Scheduled / manual** → compares against the latest non-prerelease; creates a standard pre-release
- **Push to `development`** → always runs; creates a draft pre-release with a timestamp suffix

**Workflow 2** downloads the game files in a `setup` job, then runs these jobs in parallel:

- **data**: parses `Data/**/*.bundle` and `I18n/*.bin` to JSON (`pnpm extract`), generates `dofus.sqlite` (`pnpm db`), uploads both
- **proto**: runs `Il2CppDumper.exe` then `protodec.exe` on `GameAssembly.dll` + `global-metadata.dat` → `dofus.proto`
- **maps**: parses `Map/Data/**/*.bundle` → `maps.sqlite` (`pnpm maps`)
- **images**: exports `Picto/**/*.bundle` → `images-<category>.zip` (`dotnet cs/... images <picto folder> <output folder>`)

Once all four succeed, the release is promoted from pre-release to latest (dev releases stay drafts). Workflow 2 also supports `workflow_dispatch` with a `release_tag` input to re-populate an existing pre-release without re-running the version check; uploads overwrite existing assets.

## Developer Instructions

### Prerequisites

- [pnpm](https://pnpm.io/installation)
- Node.js v20
- dotnet v8

### Setup

```bash
pnpm install
```

Copy the .env.dist file to a .env and fill your Dofus folder path

### Available Scripts

1. First executes `pnpm extract` to convert game files to readable .json files
2. Then runs `pnpm db` to generate a .sqlite file from .json files

Images are exported by the C# tool directly, without going through JSON:

```bash
dotnet build cs -c Release
dotnet cs/bin/Release/net8.0/unity-bundle-unwrap.dll images <folder with Picto bundles> <output folder> [--only item monster]
```

`pnpm maps` reads the map bundles (`<INPUT_FOLDER>/Dofus_Data/StreamingAssets/Content/Map/Data`) and writes the interactive elements of every map to `maps.sqlite` (or `MAP_INTERACTIONS_DB`). It doesn't go through JSON: the C# tool's `map-interactions` command reads only those elements, all bundles in parallel.

### Running the pipeline locally

Use `run-local.ps1` to replicate the full CI pipeline on your machine:

```powershell
# Full pipeline (download → parse → db → maps → images → proto)
.\run-local.ps1

# Skip download, re-parse and regenerate databases from existing temp/
.\run-local.ps1 -SkipDownload

# Skip download and parse, only regenerate databases from existing json/
.\run-local.ps1 -SkipDownload -SkipParse

# Only re-export images from existing temp/
.\run-local.ps1 -SkipDownload -SkipParse -SkipDatabase -SkipMaps -SkipProto

# Skip everything except proto generation
.\run-local.ps1 -SkipDownload -SkipParse -SkipDatabase -SkipMaps -SkipImages

# Create a GitHub release after the pipeline (requires GH_TOKEN)
.\run-local.ps1 -CreateRelease -ReleaseTag my-test
```
