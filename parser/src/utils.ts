import fs from "fs/promises";

export async function createFoldersRecursively(folder: string) {
  try {
    await fs.mkdir(folder, { recursive: true });
  } catch {}
}
