import fs from "fs/promises";
import { createWriteStream } from "fs";
import path from "path";
import { INPUT_FOLDER } from ".";

export const parseTranslations = async (file: string, outputFolder: string) => {
  const fileBin = await fs.readFile(file);

  const lang = path.basename(file, ".bin");
  const outputFilePath = path.join(outputFolder, `i18n_${lang}.json`);

  const fileExists = await fs
    .access(outputFilePath)
    .then(() => true)
    .catch(() => false);
  if (fileExists) {
    await fs.rm(outputFilePath);
  }

  const outputStream = createWriteStream(outputFilePath);
  outputStream.write("{");
  // const translations: Map<string, string> = new Map();

  // skip the first 3 bytes, i thought they contained (strLentgh, str containing the language code)
  // but all the files have "026672" = strLen = 2, str = "fr" which is weird
  let offset = 3;

  const nbTranslations = fileBin.readUint32LE(offset);
  offset += 4;

  let cpt = 0;

  while (offset < fileBin.byteLength && cpt < nbTranslations) {
    cpt++;
    const translationId = fileBin.readUint32LE(offset);
    offset += 4;
    let translationOffset = fileBin.readUint32LE(offset);
    offset += 4;

    const string = readSingleTranslation(fileBin, translationOffset);

    const isLast = cpt === nbTranslations;
    outputStream.write(
      `"${translationId}": ${JSON.stringify(string)}${isLast ? "" : ","}`,
    );
  }

  outputStream.write("}");
  outputStream.end();
  outputStream.close();
};

export const readSingleTranslation = (
  fileBin: Buffer,
  translationOffset: number,
) => {
  const translationLengthVariableInt = readVariableInt8(
    fileBin,
    translationOffset,
  );

  const translationLength = translationLengthVariableInt.value;
  translationOffset += translationLengthVariableInt.offset - 1;

  let string = Buffer.from(
    fileBin.subarray(
      translationOffset + 1,
      translationOffset + 1 + translationLength,
    ),
  ).toString("utf-8");

  return string;
};

function readVariableInt8(buffer: Buffer, offset = 0) {
  let value = 0;
  let shift = 0;
  let currentOffset = offset;

  while (true) {
    if (currentOffset >= buffer.length) {
      throw new Error("Buffer overflow while reading variable int");
    }

    const byte = buffer[currentOffset];
    value |= (byte & 0x7f) << shift;
    currentOffset++;

    if ((byte & 0x80) === 0) {
      break;
    }

    shift += 7;
    if (shift >= 32) {
      throw new Error("Variable int is too big");
    }
  }

  return {
    value,
    offset: currentOffset - offset,
  };
}
