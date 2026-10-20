# AgyClient — Cross-Platform Antigravity Control Center & CLI

**AgyClient** is a local control center and command-line interface (`agyclient` / `agy-client`) for the Google Antigravity CLI (`agy`) on **Linux**, **macOS**, and **Windows**. It provides both a unified web dashboard (`http://127.0.0.1:3000`) and a full terminal CLI to launch and monitor parallel `agy` processes, stream live `stream-json` events, manage `Allow` / `Ask` / `Deny` permission rules and OS-level deletion locks, track officially reported token usage and rolling-window budgets, orchestrate multi-agent DAG workflows, and isolate concurrent agent work in Git worktrees.

---

## Command-Line Installation (Linux, macOS & Windows)

### Option A: Linux & macOS Installer (`install.sh`)
Clone the repository and run the installer script to build all packages and install `agyclient` (and `agy-client`) into `~/.local/bin`:

```bash
git clone https://github.com/haase-laurenz/AgyClient.git
cd AgyClient
chmod +x scripts/install.sh scripts/start-agyclient.sh
./scripts/install.sh
```

Or install in one line on Linux/macOS:
```bash
curl -fsSL https://raw.githubusercontent.com/haase-laurenz/AgyClient/main/scripts/install.sh | bash
```

Or link globally via `npm`:
```bash
./scripts/install.sh --global
```

To uninstall the CLI links:
```bash
./scripts/install.sh --uninstall
```

### Option B: Standalone Windows Installer (`cliagent_installer.exe` — No Repo Clone Required)
Download and run **[`cliagent_installer.exe`](https://github.com/haase-laurenz/AgyClient/raw/main/dist-installer/cliagent_installer.exe)** (215 KB self-contained pre-built bundle, includes Web UI, Backend, CLI & runtime dependencies) or execute this one-liner in PowerShell:

```powershell
irm https://github.com/haase-laurenz/AgyClient/raw/main/dist-installer/cliagent_installer.exe -OutFile "$env:TEMP\cliagent_installer.exe"; & "$env:TEMP\cliagent_installer.exe" --silent
```

Or if you cloned the repository on Windows:

```powershell
.\scripts\install.ps1
```
*(To rebuild the `.exe` installer from source at any time, run `npm run build:installer`.)*

### Option C: Universal `npm` Global Link (Linux / macOS / Windows)
Requires **Node.js >= 22.5.0** and **Git**:

```bash
npm install
npm run build
npm link
```

---

## CLI Interface (`agyclient` / `agy-client`)

Once installed, anyone can use `agyclient` (or `agy-client`) from any directory on Linux, macOS, or Windows:

```bash
# 1. Start the Web Control Center at http://127.0.0.1:3000 (and open browser)
agyclient start --open
agyclient start --port 3000 --workspace /path/to/project

# 2. Run environment diagnostics (Node.js, Git, agy CLI, SQLite, OS delete lock)
agyclient doctor

# 3. Inspect workspace status, active agents, permission rules & token totals
agyclient status

# 4. Run a managed agent directly in the terminal (great for headless Linux / SSH)
agyclient run "Analyze this repository and summarize its architecture"
agyclient run "Implement feature X and run tests" --worktree --model gemini-4-argon-medium --effort high

# 5. List managed agent sessions and native agy CLI conversations
agyclient sessions

# 6. View official token usage and rolling-window model budgets
agyclient usage

# 7. Manage permissions & evaluate commands against multi-layer guardrails
agyclient permissions status
agyclient permissions preset autonomous-safe
agyclient permissions eval "rm -rf ./src"
agyclient permissions lock

# 8. Manage isolated Git worktrees from the command line
agyclient worktrees list
agyclient worktrees create feature-audit
agyclient worktrees diff
agyclient worktrees integrate .worktrees/feature-audit
```

All inspection commands (`doctor`, `status`, `sessions`, `usage`, `permissions`, `worktrees`) also support `--json` for scripting and automation.

---

## Architecture & Monorepo Structure

```text
AgyClient/
├── apps/
│   ├── web/                  # React + TypeScript + Vite dashboard
│   └── server/               # Local Node.js + WebSocket + SQLite backend & CLI (cli.ts)
├── packages/
│   ├── agy-adapter/          # CLI flag builder, stream-json parser, SQLite/transcript reader
│   ├── process-manager/      # Cross-platform parallel process spawner & tree terminator
│   ├── permissions/          # settings.json rule editor, backups, bypass guardrails & OS delete lock
│   ├── usage/                # Official token/turn/duration aggregator & local rolling-window quota tracker
│   ├── orchestrator/         # Multi-agent DAG workflow runner (independent processes & subagents)
│   └── git-manager/          # Isolated Git worktrees, diff inspector & conflict-safe merge-tree integration
├── docs/
│   └── PHASE0_FEASIBILITY.md # Validated CLI 1.4.3 technical feasibility report
├── scripts/
│   ├── install.sh            # Linux / macOS CLI installer (~/.local/bin + npm link)
│   ├── start-agyclient.sh    # Linux / macOS startup script
│   ├── install.ps1           # Windows PowerShell global CLI installer
│   ├── start-agyclient.ps1   # Windows PowerShell startup script
│   └── start-agyclient.cmd   # Windows batch launcher
├── tests/
│   └── agyclient.test.ts     # Automated unit, CLI, integration & security boundary test suite
└── PLAN.md
```

---

## Security & Cross-Platform Guardrails

* **Localhost Binding:** Binds strictly to `127.0.0.1` by default and validates `Host` and `Origin` headers to prevent DNS-rebinding or cross-origin browser requests.
* **Defense-in-Depth Deletion Protection:**
  1. **Settings Rules (`~/.gemini/antigravity-cli/settings.json`):** Central `Allow`, `Ask`, and `Deny` rules with regex validation and automatic timestamped backups before every edit.
  2. **Multi-Layer Interpreter Bypass Guard:** Detects direct shell deletion commands (`rm`, `unlink`, `del`, `Remove-Item`, `rmdir`, `shred`, `mkfs`), inline interpreter deletion bypasses (`fs.rmSync`, `os.remove`, `shutil.rmtree`), and destructive Git resets (`git reset --hard`, `git clean -fd`).
  3. **Cross-Platform OS-Level Delete Lock:**
     * **Linux (`chattr +a`):** Append-only directory attribute (`ext4`/`xfs`/`btrfs`) so files can be created and modified inside a directory but never unlinked/deleted.
     * **macOS (`chmod +a`):** Native APFS/HFS+ NFSv4 ACL (`deny delete,delete_child`).
     * **Windows (`icacls`):** Native NTFS `(OI)(CI)(DE,DC)` Delete / Delete Child deny ACL.
