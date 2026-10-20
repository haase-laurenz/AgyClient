import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log('========================================================');
console.log('  Building AgyClient Standalone Windows Installer (.exe)');
console.log('========================================================');

// 1. Ensure project is built
if (
  !fs.existsSync(path.join(repoRoot, 'apps', 'server', 'dist', 'cli.js')) ||
  !fs.existsSync(path.join(repoRoot, 'apps', 'web', 'dist', 'index.html'))
) {
  console.log('[1/4] Running npm run build...');
  const buildRes = spawnSync('npm.cmd', ['run', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (buildRes.status !== 0) {
    console.error('Build failed.');
    process.exit(1);
  }
} else {
  console.log('[1/4] Pre-built artifacts found in apps/server/dist & apps/web/dist.');
}

// 2. Stage self-contained runtime bundle in temp directory
const stageId = `agyclient-stage-${Date.now()}`;
const stageRoot = path.join(os.tmpdir(), stageId);
const payloadDir = path.join(stageRoot, 'payload');
fs.mkdirSync(payloadDir, { recursive: true });

console.log('[2/4] Assembling self-contained runtime bundle (server, web UI, packages & ws)...');

// Copy root package.json
fs.copyFileSync(
  path.join(repoRoot, 'package.json'),
  path.join(payloadDir, 'package.json')
);

// Copy apps/server/package.json and dist
fs.mkdirSync(path.join(payloadDir, 'apps', 'server'), { recursive: true });
fs.copyFileSync(
  path.join(repoRoot, 'apps', 'server', 'package.json'),
  path.join(payloadDir, 'apps', 'server', 'package.json')
);
copyDirRecursive(
  path.join(repoRoot, 'apps', 'server', 'dist'),
  path.join(payloadDir, 'apps', 'server', 'dist')
);

// Copy apps/web/dist
copyDirRecursive(
  path.join(repoRoot, 'apps', 'web', 'dist'),
  path.join(payloadDir, 'apps', 'web', 'dist')
);

// Copy internal workspace packages into node_modules/@agy-client/* as real directories
const internalPackages = [
  'agy-adapter',
  'permissions',
  'usage',
  'process-manager',
  'git-manager',
  'orchestrator',
];

for (const pkg of internalPackages) {
  const srcPkgDir = path.join(repoRoot, 'packages', pkg);
  const destPkgDir = path.join(payloadDir, 'node_modules', '@agy-client', pkg);
  fs.mkdirSync(destPkgDir, { recursive: true });
  fs.copyFileSync(
    path.join(srcPkgDir, 'package.json'),
    path.join(destPkgDir, 'package.json')
  );
  copyDirRecursive(path.join(srcPkgDir, 'dist'), path.join(destPkgDir, 'dist'));
}

// Copy runtime dependency: ws
copyDirRecursive(
  path.join(repoRoot, 'node_modules', 'ws'),
  path.join(payloadDir, 'node_modules', 'ws')
);

// 3. Create payload.zip using .NET ZipFile via PowerShell
const zipPath = path.join(stageRoot, 'payload.zip');
console.log('[3/4] Compressing runtime bundle into embedded archive...');
const psZipCmd = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${payloadDir.replace(/'/g, "''")}', '${zipPath.replace(/'/g, "''")}')`;
const zipRes = spawnSync('powershell', ['-NoProfile', '-Command', psZipCmd], {
  encoding: 'utf-8',
});
if (zipRes.status !== 0 || !fs.existsSync(zipPath)) {
  console.error('Failed to create payload.zip:', zipRes.stderr || zipRes.stdout);
  process.exit(1);
}

// 4. Write C# Self-Extracting Installer source and compile with csc.exe
const csPath = path.join(stageRoot, 'Installer.cs');
const csSource = `
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;

class AgyClientInstaller
{
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        uint Msg,
        UIntPtr wParam,
        string lParam,
        uint fuFlags,
        uint uTimeout,
        out UIntPtr lpdwResult
    );

    static void BroadcastEnvironmentChange()
    {
        try
        {
            UIntPtr result;
            SendMessageTimeout((IntPtr)0xffff, 0x001A, UIntPtr.Zero, "Environment", 0x0002, 2000, out result);
        }
        catch { }
    }

    static bool CheckNodeInstalled(out string versionText)
    {
        versionText = "";
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("node", "--version");
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            using (Process p = Process.Start(psi))
            {
                versionText = p.StandardOutput.ReadToEnd().Trim();
                p.WaitForExit(5000);
                return p.ExitCode == 0 && versionText.StartsWith("v");
            }
        }
        catch
        {
            return false;
        }
    }

    static int Main(string[] args)
    {
        bool silent = false;
        foreach (string a in args)
        {
            if (a.Equals("--silent", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("/S", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("-y", StringComparison.OrdinalIgnoreCase))
            {
                silent = true;
            }
        }

        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("========================================================");
        Console.WriteLine("  AgyClient v1.0.0 — Standalone Windows Installer");
        Console.WriteLine("========================================================");
        Console.ResetColor();

        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string installRoot = Path.Combine(localAppData, "AgyClient");
        string appDir = Path.Combine(installRoot, "app");
        string binDir = Path.Combine(installRoot, "bin");

        // 1. Check Node.js runtime
        string nodeVer;
        if (CheckNodeInstalled(out nodeVer))
        {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("[1/4] Node.js detected: " + nodeVer);
            Console.ResetColor();
        }
        else
        {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine("[1/4] Node.js not found in PATH. Attempting automatic install via winget...");
            Console.ResetColor();
            try
            {
                ProcessStartInfo wingetPsi = new ProcessStartInfo("winget", "install OpenJS.NodeJS --accept-package-agreements --accept-source-agreements");
                wingetPsi.UseShellExecute = false;
                using (Process wp = Process.Start(wingetPsi))
                {
                    wp.WaitForExit();
                }
            }
            catch
            {
                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine("      Please ensure Node.js >= 22.5.0 is installed from https://nodejs.org");
                Console.ResetColor();
            }
        }

        // 2. Extract embedded payload.zip into %LOCALAPPDATA%\\AgyClient\\app
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine("[2/4] Extracting pre-built AgyClient bundle to " + appDir + "...");
        Console.ResetColor();

        Directory.CreateDirectory(appDir);
        Assembly asm = Assembly.GetExecutingAssembly();
        using (Stream resStream = asm.GetManifestResourceStream("AgyClientPayload.zip"))
        {
            if (resStream == null)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("[ERROR] Embedded payload resource not found.");
                Console.ResetColor();
                return 1;
            }
            using (ZipArchive archive = new ZipArchive(resStream, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string fullPath = Path.Combine(appDir, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                    if (string.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(fullPath);
                        continue;
                    }
                    string parentDir = Path.GetDirectoryName(fullPath);
                    if (!string.IsNullOrEmpty(parentDir))
                    {
                        Directory.CreateDirectory(parentDir);
                    }
                    using (Stream entryStream = entry.Open())
                    using (FileStream outStream = new FileStream(fullPath, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        entryStream.CopyTo(outStream);
                    }
                }
            }
        }

        // 3. Create CLI launchers (agyclient.cmd, agy-client.cmd, agyclient.ps1, agy-client.ps1)
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine("[3/4] Creating CLI launchers in " + binDir + "...");
        Console.ResetColor();

        Directory.CreateDirectory(binDir);
        string cliJsPath = Path.Combine(appDir, "apps", "server", "dist", "cli.js");

        string cmdContent =
            "@echo off\\r\\n" +
            "setlocal\\r\\n" +
            "set \\"NODE_EXE=node\\"\\r\\n" +
            "where node >nul 2>nul || set \\"NODE_EXE=%ProgramFiles%\\\\nodejs\\\\node.exe\\"\\r\\n" +
            "\\"%NODE_EXE%\\" \\"" + cliJsPath + "\\" %*\\r\\n" +
            "exit /b %ERRORLEVEL%\\r\\n";
        File.WriteAllText(Path.Combine(binDir, "agyclient.cmd"), cmdContent);
        File.WriteAllText(Path.Combine(binDir, "agy-client.cmd"), cmdContent);

        // PowerShell .ps1 launchers are blocked by the default execution policy; remove stale ones
        foreach (string stale in new string[] { "agyclient.ps1", "agy-client.ps1" })
        {
            try { File.Delete(Path.Combine(binDir, stale)); } catch { }
        }

        // Also install shims into WindowsApps, which is already on PATH in every session,
        // so 'agyclient' works immediately without reopening the terminal.
        try
        {
            string winApps = Path.Combine(localAppData, "Microsoft", "WindowsApps");
            if (Directory.Exists(winApps))
            {
                File.WriteAllText(Path.Combine(winApps, "agyclient.cmd"), cmdContent);
                File.WriteAllText(Path.Combine(winApps, "agy-client.cmd"), cmdContent);
            }
        }
        catch { }

        // 4. Add %LOCALAPPDATA%\\AgyClient\\bin to Windows User PATH
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine("[4/4] Registering 'agyclient' in Windows User PATH...");
        Console.ResetColor();

        string currentPath = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.User) ?? "";
        if (currentPath.IndexOf(binDir, StringComparison.OrdinalIgnoreCase) < 0)
        {
            string newPath = string.IsNullOrEmpty(currentPath) ? binDir : (currentPath.TrimEnd(';') + ";" + binDir);
            Environment.SetEnvironmentVariable("Path", newPath, EnvironmentVariableTarget.User);
            BroadcastEnvironmentChange();
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("      Added '" + binDir + "' to User PATH.");
            Console.ResetColor();
        }
        else
        {
            Console.ForegroundColor = ConsoleColor.Green;
            Console.WriteLine("      '" + binDir + "' is already in User PATH.");
            Console.ResetColor();
        }

        Console.WriteLine();
        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine("========================================================");
        Console.WriteLine("  Installation Complete!");
        Console.WriteLine("========================================================");
        Console.ResetColor();
        Console.WriteLine("  Installed to : " + appDir);
        Console.WriteLine("  CLI Binary   : " + Path.Combine(binDir, "agyclient.cmd"));
        Console.WriteLine();
        Console.WriteLine("  Open a new terminal (PowerShell or CMD) and run:");
        Console.ForegroundColor = ConsoleColor.White;
        Console.WriteLine("    agyclient start --open      # Launch Web Control Center");
        Console.WriteLine("    agyclient doctor            # Verify setup");
        Console.WriteLine("    agyclient status            # Show workspace status");
        Console.WriteLine("    agyclient run \\"<prompt>\\"    # Run an agent in terminal");
        Console.ResetColor();
        Console.WriteLine("========================================================");

        if (!silent && Environment.UserInteractive && !Console.IsInputRedirected)
        {
            Console.WriteLine("Press Enter to close installer...");
            try { Console.ReadLine(); } catch { }
        }
        return 0;
    }
}
`;

fs.writeFileSync(csPath, csSource, 'utf-8');

const outDir = path.join(repoRoot, 'dist-installer');
fs.mkdirSync(outDir, { recursive: true });

const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const exeTargets = [
  path.join(outDir, 'cliagent_installer.exe'),
  path.join(outDir, 'agyclient_installer.exe'),
];

console.log('[4/4] Compiling standalone .exe installer with csc.exe...');
for (const outExe of exeTargets) {
  const cscRes = spawnSync(
    cscPath,
    [
      '/nologo',
      '/target:exe',
      '/optimize+',
      `/out:${outExe}`,
      `/resource:${zipPath},AgyClientPayload.zip`,
      '/reference:System.IO.Compression.dll',
      '/reference:System.IO.Compression.FileSystem.dll',
      csPath,
    ],
    { encoding: 'utf-8' }
  );

  if (cscRes.status !== 0) {
    console.error('csc.exe compilation failed:', cscRes.stdout, cscRes.stderr);
    process.exit(1);
  }
  const sizeKb = Math.round(fs.statSync(outExe).size / 1024);
  console.log(`  -> Built ${outExe} (${sizeKb} KB)`);
}

// 5. Build Standalone Self-Extracting Linux / macOS Installer (cliagent_installer.sh)
function collectFilesAsBundle(baseDir, currentDir = baseDir, map = {}) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const full = path.join(currentDir, entry.name);
    const rel = path.relative(baseDir, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      collectFilesAsBundle(baseDir, full, map);
    } else if (entry.isFile()) {
      map[rel] = fs.readFileSync(full).toString('base64');
    }
  }
  return map;
}

const bundleMap = collectFilesAsBundle(payloadDir);
const compressedPayloadB64 = zlib
  .gzipSync(Buffer.from(JSON.stringify(bundleMap), 'utf-8'), { level: 9 })
  .toString('base64');

const shInstallerContent = `#!/usr/bin/env bash
# ==============================================================================
# AgyClient v1.0.0 — Standalone Self-Extracting Linux & macOS Installer
# Requires only Node.js >= 22.5.0 (no git, no npm install, no build step needed)
# ==============================================================================
set -euo pipefail

INSTALL_ROOT="\${AGYCLIENT_INSTALL_DIR:-\$HOME/.local/share/agyclient}"
APP_DIR="\$INSTALL_ROOT/app"
BIN_DIR="\${AGYCLIENT_BIN_DIR:-\$HOME/.local/bin}"

echo "========================================================"
echo "  AgyClient v1.0.0 — Standalone Linux / macOS Installer"
echo "========================================================"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js (>= 22.5.0) is required. Please install Node.js first." >&2
  exit 1
fi

NODE_VER="\$(node -v)"
echo "[1/3] Detected Node.js \$NODE_VER"

echo "[2/3] Extracting pre-built AgyClient bundle into \$APP_DIR..."
mkdir -p "\$APP_DIR" "\$BIN_DIR"

PAYLOAD_B64="${compressedPayloadB64}"

AGY_TARGET_DIR="\$APP_DIR" AGY_PAYLOAD="\$PAYLOAD_B64" node -e '
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const target = process.env.AGY_TARGET_DIR;
const raw = zlib.gunzipSync(Buffer.from(process.env.AGY_PAYLOAD, "base64")).toString("utf-8");
const files = JSON.parse(raw);
for (const [rel, b64] of Object.entries(files)) {
  const full = path.join(target, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.from(b64, "base64"));
}
'

chmod +x "\$APP_DIR/apps/server/dist/cli.js"

echo "[3/3] Creating CLI executables in \$BIN_DIR..."
cat > "\$BIN_DIR/agyclient" <<EOF
#!/usr/bin/env bash
exec node "\$APP_DIR/apps/server/dist/cli.js" "\\\$@"
EOF
chmod +x "\$BIN_DIR/agyclient"
ln -sf "\$BIN_DIR/agyclient" "\$BIN_DIR/agy-client"

# Add ~/.local/bin to shell profile if not already in PATH
if [[ ":\$PATH:" != *":\$BIN_DIR:"* ]]; then
  for rc in "\$HOME/.bashrc" "\$HOME/.zshrc" "\$HOME/.profile"; do
    if [ -f "\$rc" ] && ! grep -q "\$BIN_DIR" "\$rc" 2>/dev/null; then
      echo "" >> "\$rc"
      echo "# Added by AgyClient Installer" >> "\$rc"
      echo "export PATH=\\"\$BIN_DIR:\\\$PATH\\"" >> "\$rc"
    fi
  done
fi

echo ""
echo "========================================================"
echo "  Installation Complete!"
echo "========================================================"
echo "  Installed to : \$APP_DIR"
echo "  CLI Binary   : \$BIN_DIR/agyclient"
echo ""
echo "  Run from any terminal:"
echo "    agyclient start --open      # Launch Web Control Center"
echo "    agyclient doctor            # Verify setup"
echo "    agyclient status            # Show workspace status"
echo "    agyclient run \\"<prompt>\\"    # Run an agent in terminal"
echo "========================================================"
`;

const shTargets = [
  path.join(outDir, 'cliagent_installer.sh'),
  path.join(outDir, 'agyclient_installer.sh'),
];

for (const outSh of shTargets) {
  fs.writeFileSync(outSh, shInstallerContent.replace(/\r\n/g, '\n'), 'utf-8');
  const sizeKb = Math.round(fs.statSync(outSh).size / 1024);
  console.log(`  -> Built ${outSh} (${sizeKb} KB)`);
}

console.log('\nDone! Standalone Windows (.exe) and Linux/macOS (.sh) installers are ready in dist-installer/');
