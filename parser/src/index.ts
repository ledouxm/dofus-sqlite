import path from "path";
import dotenv from "dotenv";
import fs from "fs/promises";
import { exec } from "child_process";
import { createFoldersRecursively } from "./utils";
import { parseTranslations, readSingleTranslation } from "./parseTranslations";

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
  const bundleFiles = await fs.readdir(path.join(INPUT_FOLDER, "Data"));
  const translationsFiles = await fs.readdir(path.join(INPUT_FOLDER, "I18n"));

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

  const tempDir = path.join(OUTPUT_FOLDER, ".mapdata_temp");
  await createFoldersRecursively(tempDir);

  const allRefIds: any[] = [];
  let mergedVersion: number | undefined;

  for (const file of mapBundles) {
    console.log("parsing map bundle", file);
    const tempFile = path.join(tempDir, `${file}.json`);

    await parseBundleFile({
      inputFile: path.join(mapDataDir, file),
      outputFile: tempFile,
    });

    const content = JSON.parse(await fs.readFile(tempFile, "utf-8"));
    if (content.references?.RefIds) {
      if (mergedVersion === undefined) {
        mergedVersion = content.references.version;
      }
      allRefIds.push(...content.references.RefIds);
    }
  }

  const mergedJson = {
    references: {
      version: mergedVersion ?? 1,
      RefIds: allRefIds,
    },
  };

  await fs.writeFile(
    path.join(OUTPUT_FOLDER, "mapdata.json"),
    JSON.stringify(mergedJson),
  );

  console.log(
    `Merged ${allRefIds.length} map entries into mapdata.json`,
  );

  await fs.rm(tempDir, { recursive: true, force: true });
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
