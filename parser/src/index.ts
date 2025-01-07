import { GenericContainer, Wait } from "testcontainers";
import path from "path";
import dotenv from "dotenv";
import fs from "fs/promises";
import { parseBinFile } from "./parseTranslations";

dotenv.config();

const INPUT_FOLDER = path.join(
  process.env.LOCALAPPDATA!,
  "Ankama",
  "Dofus-dofus3",
  "Dofus_Data",
  "StreamingAssets",
  "Content",
);

const INPUT_FILE = "I18n/fr.bin";
const OUTPUT_FILE = "output";

const main = async () => {
  const a = await parseBinFile(path.join(INPUT_FOLDER, INPUT_FILE));
  console.log(a);
  // console.log("### PARSING BUNDLE FILES");
  // const files = await fs.readdir(path.join(INPUT_FOLDER, "Data"));

  // const container = await new GenericContainer("stelzo/doduda-umbu:amd64")
  //   .withCommand(["tail", "-f", "/dev/null"])
  //   .withBindMounts([
  //     {
  //       source: INPUT_FOLDER,
  //       target: "/app/data",
  //     },
  //   ])
  //   .start();

  // for (const file of files) {
  //   if (file.endsWith(".bundle")) {
  //     console.log("parseBundleFile", file);
  //     await container.exec([
  //       "dotnet",
  //       "out/unity-bundle-unwrap.dll",
  //       `/app/data/Data/${file}`,
  //       `/app/data/output/${file}.json`,
  //     ]);
  //     //   await parseBundleFile({
  //     //     inputFile: `Data/${file}`,
  //     //     outputFile: `output/${file}.json`,
  //     //   });
  //   }
  // }
};

const parseBundleFile = async ({
  inputFile,
  outputFile,
}: {
  inputFile: string;
  outputFile: string;
}) => {
  const container = await new GenericContainer("stelzo/doduda-umbu:amd64")
    .withCommand([
      "dotnet",
      "out/unity-bundle-unwrap.dll",
      `/app/data/${inputFile}`,
      `/app/data/${outputFile}`,
    ])
    .withBindMounts([
      {
        source: INPUT_FOLDER,
        target: "/app/data",
      },
    ])
    .start();

  await container.stop();
};

main();
