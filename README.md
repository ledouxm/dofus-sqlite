# Dofus-sqlite

👨‍💻 **Up to date Dofus 3 data, in a convenient SQLite database**

## How to use

1. Go to the [Releases](../../releases) page
2. Download the latest `dofus.sqlite` file
3. That's it! The database is ready to use

_Note: This repo contains the extraction code that creates these releases. If you just want the data, you don't need to clone this repository._

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
