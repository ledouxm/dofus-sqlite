import fs from "fs/promises";
import { execFile } from "child_process";

export async function createFoldersRecursively(folder: string) {
  try {
    await fs.mkdir(folder, { recursive: true });
  } catch {}
}

export const DLL_PATH = "../cs/bin/Debug/net8.0/unity-bundle-unwrap.dll";

const run = (command: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error(stdout, stderr);
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });

// Always builds (incremental, ~1s when nothing changed) so a stale DLL from an older
// checkout can't be missing a command
export const buildDotnetTool = () => run("dotnet", ["build", "../cs"]);

export const runDotnetTool = (args: string[]) => run("dotnet", [DLL_PATH, ...args]);
