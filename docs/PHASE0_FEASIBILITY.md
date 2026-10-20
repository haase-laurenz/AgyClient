# Phase 0: Technical Feasibility & CLI Validation Report

**Date:** 2026-10-20  
**Environment:** Windows / PowerShell, Node.js `v24.21.0`, npm `10.5.0`, Git `2.41.0.windows.3`  
**Installed Antigravity CLI (`agy`):** `1.4.3`

---

## 1. CLI Capabilities & Command Surface

### 1.1 Available Flags (`agy --help`)
* **Execution & Headless Mode:**
  * `-p`, `--print`, `--prompt`: Run a prompt non-interactively and exit when complete.
  * `--print-timeout`: Optional time limit for print mode (`0s` default = wait until completion).
  * `--output-format`: `text` (default), `json`, or `stream-json` (NDJSON real-time event stream).
  * `--input-format`: `text` (default) or `stream-json` (reads one NDJSON message per line from `stdin` and runs a turn for each; requires `--output-format stream-json`).
  * `--json-schema`: Enforce structured output schema on final result.
  * `-i`, `--prompt-interactive`: Run an initial prompt interactively and continue session.
* **Session & Workspace Management:**
  * `-c`, `--continue`: Continue the most recent conversation.
  * `--conversation <id>`: Resume a specific conversation by UUID.
  * `--project <id|name>` / `--new-project`: Associate session with a project.
  * `--add-dir <dir>`: Add directory to workspace (repeatable).
* **Model & Agent Control:**
  * `--model <id>`: Select model for session (e.g., `gemini-4-argon-medium`, `gemini-3.8-flash-high`, `claude-sonnet-5-5-high`, etc.).
  * `--effort <level>`: Reasoning effort (`low` | `medium` | `high` | `xhigh` | `max`).
  * `--agent <name>`: Launch with a specific custom agent definition.
* **Permissions & Safety Modes:**
  * `--mode <mode>`: Execution mode (`accept-edits`, `auto`, `plan`).
  * `--sandbox`: Run in a sandbox with terminal restrictions enabled.
  * `--dangerously-skip-permissions`: Auto-approve all tool permission requests without prompting.

### 1.2 Critical CLI Flag Ordering Finding
During Phase 0 testing, we verified that `--print` consumes the immediately following CLI argument as the prompt string:
* **Incorrect:** `agy --print --output-format stream-json "My prompt"` (causes `--print` to take `"--output-format"` as the prompt and exit with code `2`).
* **Correct:** Always pass `--print=<prompt>` or place `--print`, `<prompt>` **at the end** of the argument list:
  ```powershell
  agy --output-format stream-json --model gemini-4-argon-medium --print "My prompt"
  ```
The `@agy-client/agy-adapter` package encapsulates and enforces this argument ordering.

---

## 2. Headless `stream-json` Event Protocol

Running `agy --output-format stream-json --print "<prompt>"` emits newline-delimited JSON (NDJSON) events on `stdout`:

1. **`init` Event:**
   ```json
   {
     "event": "init",
     "conversation_id": "dc0f4002-c64b-4122-abc9-1b7664b6c795",
     "init": {
       "cwd": "C:\\Users\\Laurenz Haase\\Meine_Projekte\\AgyClient",
       "tools": ["run_command", "write_to_file", "view_file", "invoke_subagent", "..."],
       "permission_mode": "request-review"
     }
   }
   ```
2. **`step_update` Events (Real-Time Streaming):**
   ```json
   {
     "event": "step_update",
     "step_update": {
       "conversation_id": "dc0f4002-c64b-4122-abc9-1b7664b6c795",
       "step_index": 1,
       "state": "ACTIVE",
       "step_type": "agent_response",
       "text_delta": "PONG"
     }
   }
   ```
   When a step transitions to `"state": "DONE"`, it includes step duration and official token usage:
   ```json
   {
     "event": "step_update",
     "step_update": {
       "conversation_id": "dc0f4002-c64b-4122-abc9-1b7664b6c795",
       "step_index": 1,
       "state": "DONE",
       "step_type": "agent_response",
       "text_delta": "\n",
       "duration_seconds": 12.4478,
       "usage": {
         "input_tokens": 7741,
         "output_tokens": 6,
         "thinking_tokens": 0,
         "cache_read_tokens": 0,
         "total_tokens": 7747
       }
     }
   }
   ```
3. **`result` Event (Turn Completion):**
   ```json
   {
     "event": "result",
     "result": {
       "conversation_id": "dc0f4002-c64b-4122-abc9-1b7664b6c795",
       "status": "SUCCESS",
       "response": "PONG\n",
       "duration_seconds": 13.5294,
       "num_turns": 1,
       "usage": {
         "input_tokens": 7741,
         "output_tokens": 6,
         "thinking_tokens": 0,
         "cache_read_tokens": 0,
         "total_tokens": 7747
       }
     }
   }
   ```

---

## 3. Local Data Sources & Persistence in `~/.gemini/antigravity-cli`

Inspection of `%USERPROFILE%\.gemini\antigravity-cli` confirmed the following official data stores:

1. **`settings.json` (Permissions & Trusted Workspaces):**
   ```json
   {
     "permissions": {
       "allow": ["command(*)", "read_file(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "mcp(*)"],
       "deny": [
         "command(regex:.*\\b(del|erase|rmdir)\\b.*)",
         "command(regex:.*\\bRemove-Item\\b.*)",
         "command(regex:.*\\brd\\b.*)",
         "command(regex:.*\\bClear-Content\\b.*)"
       ],
       "ask": []
     },
     "trustedWorkspaces": [
       "C:\\Users\\Laurenz Haase\\Meine_Projekte\\AgyClient"
     ]
   }
   ```
   * Validated rule syntax: `<scope>(<pattern>)` where `<scope>` is `command`, `read_file`, `write_file`, `read_url`, `execute_url`, or `mcp`, and `<pattern>` supports glob (`*`) or `regex:<expression>`.
2. **`conversation_summaries.db` (SQLite Database):**
   * Table `conversation_summaries` stores `conversation_id`, `title`, `preview`, `step_count`, `last_modified_time`, `workspace_uris`, `status`, `project_id`, `agent_name`, `parent_conversation_id` (links subagents to parent sessions!), `nesting_depth`, `not_fully_idle`, `killed`.
3. **`brain/<conversation_id>/.system_generated/logs/transcript.jsonl`:**
   * Contains full step-by-step trajectory logs, tool calls (`invoke_subagent`, `run_command`, etc.), timestamps, and per-step token counters (`input_tokens`, `cache_read_tokens`, `output_tokens`).
4. **`presence/<conversation_id>.lock`:**
   * Lockfiles indicating active/known conversations.

---

## 4. Usage & Quota Availability Assessment

* **Officially Reported (Exact):**
  * Available Models (`agy models` returns 13 models across Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus 5.5, Claude Sonnet 5.5, and GPT-OSS 120B).
  * Token usage per step and per session (`input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`, `total_tokens`) via `stream-json` and `transcript.jsonl`.
  * Execution time (`duration_seconds`), turn counts (`num_turns`), and step counts.
* **Estimated / Local Budget:**
  * User-defined token/request budgets and rolling time windows (e.g., 5-hour / 24-hour model family budgets).
* **Unavailable via CLI:**
  * Upstream cloud percentage quota remaining (`quota_manager.go` refreshes internally via gRPC/HTTP in memory during a session and does not expose a CLI subcommand or write remaining quota percentages to disk). AgyClient will explicitly badge upstream cloud quota as **Unavailable via CLI** and provide configurable local budget tracking labeled **Officially Reported Tokens / Local Budget Limit**.

---

## 5. Security & Deletion-Restriction Architecture

As noted in the project plan, regex blacklists in `settings.json` (`Remove-Item`, `del`, `rmdir`) only catch direct shell text matches. To provide defense-in-depth on Windows:
1. **Layer 1 – CLI Flag & Mode Enforcement:** Launch agents with `--sandbox` when sandboxing is requested, and sync `Allow` / `Ask` / `Deny` rules in `settings.json` with automatic timestamped backups before every modification.
2. **Layer 2 – Pre-Execution & Command Guardrails:** Validate both `settings.json` regex rules and AgyClient's extended destructive-operation ruleset (`git reset --hard`, `git clean -fd`, `Format-Volume`, `ri`, `rm`, `unlink`, Python/Node inline file deletion scripts).
3. **Layer 3 – Windows Filesystem ACL / Worktree Isolation:** Provide OS-level Windows `icacls` Delete-Permission Deny (`(DE,DC)` - Delete / Delete Child) helper & Git Worktree isolation so agents operate in isolated worktrees where destructive actions cannot damage the main working tree.
