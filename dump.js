const { spawn } = require("child_process");

const exePath = "./Il2CppDumper/Il2CppDumper.exe";
const args = [
  "./parser/temp/GameAssembly.dll",
  "./parser/temp/Dofus_Data/il2cpp_data/Metadata/global-metadata.dat",
]; // Add command line arguments here if needed

console.log("dumping");
const dumper = spawn(exePath, args, {
  stdio: ["pipe", "pipe", "pipe"],
});

dumper.stdout.on("data", (data) => {
  console.log(data.toString());
});

dumper.stderr.on("data", (data) => {
  console.error(data.toString());
});

dumper.on("exit", (code) => {
  console.log(`Process exited with code ${code}`);
  process.exit(0);
});
