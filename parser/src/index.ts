import { GenericContainer, Wait } from "testcontainers";
import path from "path";
import dotenv from "dotenv";
import fs from "fs/promises";
import { parseBinFile } from "./parseTranslations";
import { exec } from "child_process";

dotenv.config();

const INPUT_FOLDER =
  process.env.INPUT_FOLDER ??
  path.join("../output", "Dofus_Data", "StreamingAssets", "Content");

const OUTPUT_FOLDER = process.env.OUTPUT_FOLDER ?? "../output";

const DLL_PATH = "../cs/bin/Debug/net7.0/unity-bundle-unwrap.dll";

const main = async () => {
  // const a = await parseBinFile(path.join(INPUT_FOLDER, INPUT_FILE));
  // console.log(a);
  console.log("### PARSING BUNDLE FILES");
  const files = await fs.readdir(path.join(INPUT_FOLDER, "Data"));

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

  for (const file of files) {
    if (file.endsWith(".bundle")) {
      console.log("parseBundleFile", file);
      await parseBundleFile({
        inputFile: path.join(INPUT_FOLDER, "Data", file),
        outputFile: path.join(
          OUTPUT_FOLDER,
          `${path.basename(file).replace(".bundle", "")}.json`,
        ), //`../output/${file}.json`,
      });
      //   await parseBundleFile({
      //     inputFile: `Data/${file}`,
      //     outputFile: `output/${file}.json`,
      //   });
    }
  }
};

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
      },
    );
  });
  // const container = await new GenericContainer("stelzo/doduda-umbu:amd64")
  //   .withCommand([
  //     "dotnet",
  //     "out/unity-bundle-unwrap.dll",
  //     `/app/data/${inputFile}`,
  //     `/app/data/${outputFile}`,
  //   ])
  //   .withBindMounts([
  //     {
  //       source: INPUT_FOLDER,
  //       target: "/app/data",
  //     },
  //   ])
  //   .start();

  // await container.stop();
};

main();
