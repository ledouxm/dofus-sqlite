import path from "path";
import dotenv from "dotenv";
import fs from "fs/promises";
import { buildDotnetTool, createFoldersRecursively, runDotnetTool } from "./utils";
import { parseTranslations } from "./parseTranslations";

dotenv.config();

export const INPUT_FOLDER = path.join(
  process.env.INPUT_FOLDER ?? "../output",
  "Dofus_Data",
  "StreamingAssets",
  "Content",
);

const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER ?? "../output";

const main = async () => {
  console.log("### PARSING BUNDLE FILES");
  const bundleFiles = await fs.readdir(path.join(INPUT_FOLDER, "Data")).catch(() => [] as string[]);
  const translationsFiles = await fs.readdir(path.join(INPUT_FOLDER, "I18n")).catch(() => [] as string[]);

  await createFoldersRecursively(OUTPUT_FOLDER);

  await buildDotnetTool();

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
const parseBundleFile = ({
  inputFile,
  outputFile,
}: {
  inputFile: string;
  outputFile: string;
}) => runDotnetTool([inputFile, outputFile]);

main();
