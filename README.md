# AgyClient — Antigravity Control Center

**AgyClient** is a local Windows control center for the Google Antigravity CLI (`agy`). It provides a unified web interface (`http://127.0.0.1:3000`) to launch and monitor parallel `agy` processes, stream live `stream-json` events, manage `Allow` / `Ask` / `Deny` permission rules and Windows NTFS deletion restrictions, track officially reported token usage and rolling-window budgets, orchestrate multi-agent DAG workflows, and isolate concurrent agent work in Git worktrees.

---

## Architecture & Monorepo Structure

```text
AgyClient/
├── apps/
│   ├── web/                  # React + TypeScript + Vite dashboard
│   └── server/               # Local Node.js + WebSocket + SQLite backend (127.0.0.1:3000)
├── packages/
│   ├── agy-adapter/          # CLI flag builder, stream-json parser, SQLite/transcript reader
│   ├── process-manager/      # Parallel Windows process spawner, stream handler & taskkill tree terminator
│   ├── permissions/          # settings.json rule editor, backups, bypass guardrails & Windows icacls NTFS lock
│   ├── usage/                # Official token/turn/duration aggregator & local rolling-window quota tracker
│   ├── orchestrator/         # Multi-agent DAG workflow runner (independent processes & subagents)
│   └── git-manager/          # Isolated Git worktrees, diff inspector & conflict-safe merge-tree integration
├── docs/
│   └── PHASE0_FEASIBILITY.md # Validated CLI 1.4.3 technical feasibility report
├── scripts/
│   ├── start-agyclient.ps1   # PowerShell startup script
│   └── start-agyclient.cmd   # Windows batch launcher
├── tests/
│   └── agyclient.test.ts     # Automated unit, integration & security boundary test suite
└── PLAN.md
```

---

## Quick Start (Windows)

### 1. Launch via Startup Script
Run either startup script from the repository root:

```powershell
.\scripts\start-agyclient.ps1
```
or double-click / run:
```cmd
scripts\start-agyclient.cmd
```

Then open **`http://127.0.0.1:3000`** in your browser.

### 2. Development & Testing Commands

```powershell
# Install dependencies
npm install

# Build all packages, backend, and frontend
npm run build

# Run the automated Vitest test suite
npm test

# Start the production server at http://127.0.0.1:3000
npm start
```

---

## Security & Guardrails

* **Localhost Binding:** Binds strictly to `127.0.0.1` by default and validates `Host` and `Origin` headers to prevent DNS-rebinding or cross-origin browser requests.
* **Defense-in-Depth Deletion Protection:**
  1. **Settings Rules (`~/.gemini/antigravity-cli/settings.json`):** Central `Allow`, `Ask`, and `Deny` rules with regex validation and automatic timestamped backups before every edit.
  2. **Multi-Layer Interpreter Bypass Guard:** Detects both direct shell deletion commands (`del`, `Remove-Item`, `rmdir`, `rm`) and inline interpreter deletion bypasses (`fs.rmSync`, `os.remove`, `shutil.rmtree`) as well as destructive Git resets (`git reset --hard`, `git clean -fd`).
  3. **Windows NTFS OS-Level Delete Lock (`icacls`):** Optional OS-level `(DE,DC)` (Delete / Delete Child) deny ACL toggle per project directory, plus isolated Git worktrees (`.worktrees/`).
