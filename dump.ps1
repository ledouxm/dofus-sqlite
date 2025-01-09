Add-Type -AssemblyName System.Windows.Forms
$process = Start-Process -FilePath ".\Il2CppDumper\Il2CppDumper.exe" -ArgumentList ".\parser\temp\GameAssembly.dll", ".\parser\temp\Dofus_Data\il2cpp_data\Metadata\global-metadata.dat" -PassThru -NoNewWindow
Start-Sleep -Seconds 30
[System.Windows.Forms.SendKeys]::SendWait("`n")
$process.WaitForExit()