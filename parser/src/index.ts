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
