import path from "path";
import os from "os";
import fs from "fs/promises";
import dotenv from "dotenv";
import sqlite from "better-sqlite3";
import { buildDotnetTool, runDotnetTool } from "./utils";

dotenv.config();

const MAP_DATA_FOLDER = path.join(
  process.env.INPUT_FOLDER ?? "../output",
  "Dofus_Data",
  "StreamingAssets",
  "Content",
  "Map",
  "Data",
);

const MAP_INTERACTIONS_DB = process.env.MAP_INTERACTIONS_DB ?? "maps.sqlite";

interface MapInteraction {
  mapId: number | null;
  worldId: number;
  gfxId: number | null;
  cellId: number | null;
  interactionId: number | null;
}

const main = async () => {
  console.log("### EXTRACTING MAP INTERACTIONS");

  try {
    await fs.access(MAP_DATA_FOLDER);
  } catch {
    throw new Error(`No map bundles folder found at ${MAP_DATA_FOLDER}`);
  }

  await buildDotnetTool();

  // The C# tool only reads the interactive elements out of the bundles, instead of
  // dumping every bundle to JSON (mostly shader data) and filtering it here
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "map-interactions-"));
  const jsonPath = path.join(tempDir, "interactions.json");

  try {
    console.log(await runDotnetTool(["map-interactions", MAP_DATA_FOLDER, jsonPath]));
    const interactions: MapInteraction[] = JSON.parse(await fs.readFile(jsonPath, "utf-8"));

    await fs.rm(MAP_INTERACTIONS_DB, { force: true });
    const db = new sqlite(MAP_INTERACTIONS_DB);
    db.exec(`
      CREATE TABLE map_interactions (
        mapId         INTEGER,
        worldId       INTEGER,
        gfxId         INTEGER,
        cellId        INTEGER,
        interactionId INTEGER
      )
    `);
    const insert = db.prepare(
      "INSERT INTO map_interactions VALUES (@mapId, @worldId, @gfxId, @cellId, @interactionId)",
    );
    db.transaction(() => {
      for (const interaction of interactions) insert.run(interaction);
    })();
    db.close();

    console.log(`Wrote ${interactions.length} rows to ${MAP_INTERACTIONS_DB}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
