# Project Plan: AgyClient

**Goal:** Build a local web application for Windows (**AgyClient**) that lets you centrally manage the Antigravity CLI (`agy`), including parallel agents, automated workflows, permissions, and model usage limits.

The core principle is to build a real agent management system, not just a dashboard. It should control actual `agy` processes, monitor their status, and expose reliable usage metrics wherever the CLI makes them available.

---

## 1. Vision and Scope

* **Unified Dashboard**
  Manage projects, agents, terminals, workflows, and model usage from one interface.
* **Two Agent Execution Modes**
  Independent `agy` processes for separate tasks and subagents within a parent session, where supported by the installed CLI.
* **Autonomy with Guardrails**
  Automatically execute routine actions, block destructive operations, and require confirmation for selected high-risk actions. Enforce deletion restrictions through operating-system permissions or sandboxing wherever possible.
* **Model Usage and Limits**
  Track models, requests, tokens, execution time, and—if officially accessible—actual quota consumption and remaining percentages.

---

## 2. Proposed Technology Stack

| Component | Technology | Purpose |
| :--- | :--- | :--- |
| **Frontend** | React + TypeScript + Vite | Dashboard and controls |
| **Backend** | Node.js + TypeScript | Process management and API |
| **Real-time updates** | WebSockets | Live status, logs, and events |
| **Database** | SQLite | History, projects, and configuration |
| **Process management** | Windows child processes / ConPTY | Launch and manage `agy` sessions |
| **Version control** | Git CLI + worktrees | Isolation and code review |
| **Testing** | Vitest + Playwright | Backend and UI tests |

A local backend is necessary because a browser-only application cannot reliably start and control local CLI processes or manage interactive terminal sessions.

---

## 3. Implementation Roadmap

Eight phases are planned. Each phase produces a testable result.

### P0: Technical Feasibility (0.5–1 day)
* Inspect the installed `agy` version and available commands.
* Test headless mode, structured output, subagents, and session resumption.
* Investigate access to usage information and permission settings.
* Test destructive-command restrictions and interactive approval prompts.
* **Deliverable:** A validated technical design before implementation begins.

### P1: Dashboard and Backend Foundation (1–2 days)
* Build the React frontend and local Node.js backend.
* Define project and agent-session data models.
* Implement navigation, status cards, and live events.
* Persist history and configuration in SQLite.
* **Deliverable:** A working web interface at `http://127.0.0.1:3000`.

### P2: Process and Terminal Manager (2–3 days)
* Launch agents with a project path, task, and supported model options.
* Manage multiple independent `agy` processes in parallel.
* Stream logs, stop processes, and detect failures.
* Restore process status and session metadata after backend restarts where possible.
* **Deliverable:** Launch and monitor multiple agents directly from the browser.

### P3: Permissions and Security Rules (2–3 days)
* Visualize and manage `Allow`, `Ask`, and `Deny` rules.
* Back up, validate, and edit existing settings.
* Enforce destructive-operation restrictions at multiple levels.
* Log sensitive actions and require confirmation for security-critical changes.
* **Deliverable:** Fewer interruptions for routine actions without relying on an ineffective deletion blacklist.

### P4: Usage and Model Limits (1–3 days)
* Collect model and session information.
* Aggregate token usage, requests, and execution time per agent.
* Integrate official quota data and time windows if accessible.
* Display data source, last update, and uncertainty.
* **Deliverable:** Understand resource consumption and identify which quota metrics are genuinely available.

### P5: Multi-Agent Orchestration (2–4 days)
* Define tasks and dependencies.
* Use subagents or independent CLI processes depending on the task.
* Collect results and handle failures.
* Set concurrency and execution-time limits.
* **Deliverable:** Automated workflows for research, implementation, code review, and testing.

### P6: Git and Worktree Management (1–2 days)
* Assign separate worktrees when appropriate.
* Display diffs and branches.
* Test and selectively integrate changes.
* Detect conflicts instead of blindly merging modifications.
* **Deliverable:** Agents can work concurrently with fewer file conflicts.

### P7: Stabilization and Release (2–3 days)
* Test process crashes, restarts, and incomplete sessions.
* Validate Windows paths, permissions, and Unicode output.
* Add UI tests, documentation, and an installation script.
* Review logging, privacy, and local access security.
* **Deliverable:** A reliable local application ready for everyday use.

> *Note: Estimates assume an experienced developer working independently. Unsupported CLI interfaces or complex Windows terminal integration may increase the timeline.*

---

## 4. MVP: What Should Work First?

The first usable version prioritizes process management and visibility before advanced automation.

### MVP Checklist (9 of 9)
- [x] **P1:** Local web interface and backend
- [x] **P2:** Launch multiple independent `agy` processes
- [x] **P2:** Live logs and agent status
- [x] **P2:** Stop agents and recover session history
- [x] **P3:** Manage `Allow` / `Ask` / `Deny` centrally
- [x] **P4:** Track token usage and execution time per agent
- [x] **P4:** Integrate real model limits where accessible
- [x] **P5:** Subagents and automated workflows
- [x] **P6:** Git worktrees and code review

---

## 5. Proposed Repository Structure

```text
AgyClient/
├── apps/
│   ├── web/                  # React + Vite
│   └── server/               # Local Node.js backend
├── packages/
│   ├── agy-adapter/          # CLI integration
│   ├── process-manager/      # Processes and terminals
│   ├── permissions/          # Rules and validation
│   ├── usage/                # Model and token metrics
│   ├── orchestrator/         # Tasks and workflows
│   └── git-manager/          # Branches and worktrees
├── tests/
├── scripts/
├── PLAN.md
└── README.md
```

The `agy-adapter` package is particularly important: it isolates version-dependent CLI behavior so changes in Antigravity do not affect the entire application.

---

## 6. Security Requirements

Since AgyClient can execute commands and modify files, security must be part of the design from the beginning:

* Bind the backend to `127.0.0.1` by default.
* Protect the local API against unauthorized requests.
* Isolate agent working directories where practical.
* Enforce deletion restrictions through filesystem permissions, sandboxing, and controlled write access—not just shell-command text matching.
* Log permission changes and require explicit approval for security-critical modifications.
* Label usage data as officially reported, estimated, or unavailable.

> **Key limitation:** An agent with unrestricted write access can often overwrite or delete files through other programs. Therefore, "allow everything except deletion" must be treated as a security requirement that needs dedicated technical testing.

---

## 7. Definition of Done

The MVP is complete when you can:
1. Launch AgyClient on Windows using a startup script.
2. Run and monitor at least three independent `agy` processes simultaneously.
3. Stop agents and inspect their results.
4. Manage permissions centrally without repeatedly approving routine actions.
5. Track token usage and execution time per agent.
6. Display real model quotas when a supported data source exists, or clearly report that they are unavailable.
7. Restart the application without losing stored agent history.
8. Verify the security boundaries with automated tests.

---

## 8. First Step: Validate the CLI

Phase 0 comes first. Before building the dashboard, inspect the installed Windows version of `agy` and verify:
* Which commands are available for usage, subagents, and sessions.
* Whether structured events are available in headless mode.
* Whether interactive sessions can be controlled reliably through Windows ConPTY.
* How permission rules are actually configured.
* Whether official model quotas can be accessed programmatically.

Once these are verified, the architecture can be finalized without depending on unconfirmed interfaces.

**Recommended order:** Feasibility → Process Manager → Permissions → Usage Tracking → Orchestration → Worktrees. This delivers a useful application early and leaves room for more advanced automation later.
