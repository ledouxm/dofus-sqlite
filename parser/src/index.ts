import path from "path";
import dotenv from "dotenv";
import fs from "fs/promises";
import { exec } from "child_process";
import { createFoldersRecursively } from "./utils";
import { parseTranslations, readSingleTranslation } from "./parseTranslations";
import sqlite from "better-sqlite3";

dotenv.config();

export const INPUT_FOLDER = path.join(
  process.env.INPUT_FOLDER ?? "../output",
  "Dofus_Data",
  "StreamingAssets",
  "Content",
);

const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER ?? "../output";

const DLL_PATH = "../cs/bin/Debug/net7.0/unity-bundle-unwrap.dll";

const main = async () => {
  console.log("### PARSING BUNDLE FILES");
  const bundleFiles = await fs.readdir(path.join(INPUT_FOLDER, "Data")).catch(() => [] as string[]);
  const translationsFiles = await fs.readdir(path.join(INPUT_FOLDER, "I18n")).catch(() => [] as string[]);

  await createFoldersRecursively(OUTPUT_FOLDER);

  const dllExists = await fs
    .access(DLL_PATH)
    .then(() => true)
    .catch(() => false);

  if (!dllExists) {
    await new Promise((resolve, reject) => {
      exec("dotnet build ../cs", (error, stdout, stderr) => {
        console.log(stdout);

        if (error) {
          console.error(`exec error: ${error}`);
          reject(error);
        }

        if (stderr) {
          console.error(`stderr: ${stderr}`);
          reject(stderr);
        }

        resolve(true);
      });
    });
  }

  for (const file of bundleFiles) {
    if (file.endsWith(".bundle")) {
      console.log("parsing bundle file", file);

      await parseBundleFile({
        inputFile: path.join(INPUT_FOLDER, "Data", file),
        outputFile: path.join(OUTPUT_FOLDER, `${getOutputJsonName(file)}.json`),
      });
    }
  }

  for (const file of translationsFiles) {
    if (file.endsWith(".bin")) {
      console.log("parsing translation file", file, "to", OUTPUT_FOLDER);

      await parseTranslations(
        path.join(INPUT_FOLDER, "I18n", file),
        OUTPUT_FOLDER,
      );
    }
  }

  await parseMapBundles();
};

const parseMapBundles = async () => {
  const mapDataDir = path.join(INPUT_FOLDER, "Map", "Data");

  let files: string[];
  try {
    files = await fs.readdir(mapDataDir);
  } catch {
    console.log("No Map/Data folder found, skipping map bundle parsing.");
    return;
  }

  const mapBundles = files.filter((f) =>
    /^mapdata_assets_world_\d+\.bundle$/.test(f),
  );

  if (mapBundles.length === 0) {
    console.log("No map data bundles found, skipping.");
    return;
  }

  console.log(`### PARSING ${mapBundles.length} MAP DATA BUNDLES`);

  const MAP_INTERACTIONS_DB = process.env.MAP_INTERACTIONS_DB ?? "map_interactions.sqlite";
  try { await fs.unlink(MAP_INTERACTIONS_DB); } catch {}
  const mapDb = new sqlite(MAP_INTERACTIONS_DB);
  mapDb.exec("PRAGMA journal_mode = WAL");
  mapDb.exec(`
    CREATE TABLE map_interactions (
      mapId         INTEGER,
      worldId       INTEGER,
      gfxId         INTEGER,
      cellId        INTEGER,
      interactionId INTEGER
    )
  `);
  const insert = mapDb.prepare(
    "INSERT INTO map_interactions VALUES (@mapId, @worldId, @gfxId, @cellId, @interactionId)",
  );

  let totalInserted = 0;

  for (const file of mapBundles) {
    const worldMatch = file.match(/(\d+)/);
    const worldId = worldMatch ? parseInt(worldMatch[1]) : null;
    console.log(`parsing map bundle ${file} (world ${worldId})`);

    const outputFile = path.join(OUTPUT_FOLDER, `mapdata_world_${worldId}.json`);
    await parseBundleFile({
      inputFile: path.join(mapDataDir, file),
      outputFile,
    });

    const content = JSON.parse(await fs.readFile(outputFile, "utf-8"));
    const refIds: any[] = content.references?.RefIds ?? [];
    const monoRefs: { name: string; start: number; end: number }[] = content.monoRefs ?? [];

    mapDb.transaction(() => {
      for (const monoRef of monoRefs) {
        const mapIdMatch = monoRef.name?.match(/(\d+)/);
        const mapId = mapIdMatch ? parseInt(mapIdMatch[1]) : null;

        for (let i = monoRef.start; i < monoRef.end; i++) {
          const ref = refIds[i];
          if (ref?.type?.class === "ClientInteractiveAnimatedElementTransform" && ref.data) {
            insert.run({
              mapId,
              worldId,
              gfxId: ref.data.gfxId,
              cellId: ref.data.cellId,
              interactionId: ref.data.m_interactionId,
            });
            totalInserted++;
          }
        }
      }
    })();
  }

  mapDb.close();
  console.log(`Wrote ${totalInserted} rows to ${MAP_INTERACTIONS_DB}`);
};

const PREFIX = "data_assets_";
const SUFFIX = "root.asset.bundle";

const getOutputJsonName = (inputFile: string) => {
  const fileName = path.basename(inputFile);
  if (fileName.startsWith(PREFIX) && fileName.endsWith(SUFFIX)) {
    return fileName.replace(PREFIX, "").replace(SUFFIX, "");
  }

  return fileName;
};

// Shamefully stolen from https://github.com/dofusdude/doduda
const parseBundleFile = async ({
  inputFile,
  outputFile,
}: {
  inputFile: string;
  outputFile: string;
}) => {
  await new Promise((resolve, reject) => {
    exec(
      `dotnet ${DLL_PATH} ${inputFile} ${outputFile}`,
      (error, stdout, stderr) => {
        // console.log(stdout);

        if (error) {
          console.error(`exec error: ${error}`);
          reject(error);
        }

        if (stderr) {
          console.error(`stderr: ${stderr}`);
          reject(stderr);
        }

        resolve(true);
      },
    );
  });
};

main();
