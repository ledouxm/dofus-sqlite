const { spawn } = require("child_process");

const exePath = "./Il2CppDumper/Il2CppDumper.exe";
const args = [
  "./parser/temp/GameAssembly.dll",
  "./parser/temp/Dofus_Data/il2cpp_data/Metadata/global-metadata.dat",
]; // Add command line arguments here if needed

const process = spawn(exePath, args, {
  stdio: ["pipe", "pipe", "pipe"],
});

process.stdout.on("data", (data) => {
  console.log(data.toString());
});

process.stderr.on("data", (data) => {
  console.error(data.toString());
});

process.on("exit", (code) => {
  console.log(`Process exited with code ${code}`);
});
