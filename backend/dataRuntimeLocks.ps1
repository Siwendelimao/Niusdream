# Windows stdlib-only runtime guardian; byte locks match dataMergeLocks.py.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NisByteLock {
 [StructLayout(LayoutKind.Sequential)] public struct Ov { public UIntPtr a,b; public uint lo,hi; public IntPtr evt; }
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool LockFileEx(IntPtr h,uint flags,uint reserved,uint lo,uint hi,ref Ov ov);
}
'@
$files = [System.Collections.Generic.List[System.IO.FileStream]]::new()
try {
 $request = [Console]::ReadLine() | ConvertFrom-Json
 $roots = @($request.roots | ForEach-Object {
   $root = [IO.Path]::GetFullPath($_).ToLowerInvariant().TrimEnd('\')
   if ($root.StartsWith('\\?\unc\')) { $root = '\\' + $root.Substring(8) }
   elseif ($root.StartsWith('\\?\')) { $root = $root.Substring(4) }
   $root
 } | Sort-Object -Unique)
 foreach ($root in $roots) {
   $parent = [IO.Path]::GetDirectoryName($root)
   [IO.Directory]::CreateDirectory($parent) | Out-Null
   $hasher = [Security.Cryptography.SHA256]::Create()
   $hash = ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($root)))).Replace('-','').ToLowerInvariant().Substring(0,24)
   $hasher.Dispose()
   foreach ($name in @('owner','barrier')) {
     $file = [IO.FileStream]::new([IO.Path]::Combine($parent,".nis-$hash-$name.lock"),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
     $files.Add($file)
     $ov = [NisByteLock+Ov]::new()
     $flags = if ($name -eq 'owner') { 3 } else { 1 }
     if (-not [NisByteLock]::LockFileEx($file.SafeFileHandle.DangerousGetHandle(),$flags,0,1,0,[ref]$ov)) { throw "Data root in use: $root" }
   }
 }
 [Console]::WriteLine('{"ok":true}')
 [Console]::Out.Flush()
 [Console]::In.ReadToEnd() | Out-Null
} catch {
 [Console]::WriteLine((@{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress))
 exit 1
} finally { foreach ($file in $files) { $file.Dispose() } }
