# Pro Review

**An external review gate for agentic coding: a CLI + agent skill that packages a repo's plans, diffs, and evidence into verifiable review bundles, ships them to a ChatGPT Pro reviewer, and enforces the verdict as a hard gate before work proceeds.**

The core idea: an AI agent reviewing its own work is a weak check. Pro Review makes a *second, independent frontier model* act as a skeptical principal engineer — with enough curated evidence to do the job properly — and wires its verdict (`PASS` / `PASS_WITH_NOTES` / `NEEDS_CONTEXT` / `FAIL`) into the agent's workflow as a gate it cannot talk its way past.

Built as a Codex CLI skill plus a zero-dependency Node CLI. The agent drives the whole loop autonomously: prepare → publish → submit → record verdict → remediate or proceed.

## How it works

```
┌────────────┐   prepare    ┌──────────────────┐   publish    ┌─────────────────┐
│ repo state │ ───────────► │ review_manifest  │ ───────────► │ MCP server or   │
│ plans/diffs│  (+ secret   │ review_bundle    │  (verified   │ Google Drive    │
│ tests/docs │   scanning)  │ prompt           │   markers)   │ Docs            │
└────────────┘              └──────────────────┘              └────────┬────────┘
                                                                       │
┌────────────┐   record     ┌──────────────────┐   in-app     ┌────────▼────────┐
│ gate:      │ ◄─────────── │ structured       │ ◄─────────── │ ChatGPT Pro     │
│ proceed /  │  decision.json│ verdict schema   │   browser    │ (fresh chat,    │
│ remediate  │              │ (parsed, enforced)│  automation  │  hard prompt)   │
└────────────┘              └──────────────────┘              └─────────────────┘
```

1. **Prepare** (`pro-review prepare --mode <plan|implementation|signoff|audit|debug|migration|refactor>`): builds a run-scoped review packet — a manifest (what's under review, what evidence is included, what's deliberately excluded) and a bundle (plans, targeted file excerpts, diffs, test output). A fail-closed secret scanner excludes credentials, `.env` files, tokens, and dumps; there is no override flag by design.
2. **Publish**: serves the artifacts to ChatGPT over a read-only MCP server (`pro-review mcp`), or falls back to uploading them as Google Drive Docs. Either path embeds a run-scoped **artifact marker** and verifies it round-trip — the reviewer prompt requires the marker, so a verdict can never be based on stale or missing evidence.
3. **Review**: the agent drives ChatGPT Pro through in-app browser automation — fresh chat per run, a launcher prompt that names the exact run artifacts, and a required verdict schema. The prompt is engineered to make the reviewer *beat a local baseline critique*, not rubber-stamp: for risky work the agent first writes its own critique from code and tests, then requires the external reviewer to confirm, refute, or strengthen it.
4. **Gate** (`pro-review record-response`): the response is parsed into a structured `decision.json`. `FAIL` and unresolved `PASS_WITH_NOTES` blockers force remediation mode — an ordered fix checklist, fixes in dependency order, fresh whole-scope re-review — before the agent may report the work complete. If the external gate is unreachable, the run is recorded as `external_gate_unavailable`; the agent is forbidden from claiming a Pro verdict it didn't get.

## Design decisions worth reading

- **Evidence completeness is enforced, not hoped for.** A review of a plan that names a database table, a route, and a provider webhook must include those files (or targeted excerpts) in the bundle. If evidence is missing, the reviewer is instructed to return `NEEDS_CONTEXT` rather than issue a clean verdict on partial information.
- **Markers make verdicts verifiable.** Every run embeds a unique artifact marker; the publisher exports the published docs back and confirms the marker before the run is submittable. The reviewer must echo the run ID. This kills an entire class of silent failure (reviewing the wrong doc, a stale revision, or nothing at all).
- **`PASS` is rare by construction.** The prompt forces coverage of correctness, security, data integrity, idempotency, rollout/rollback, and missing tests for any work touching billing, webhooks, migrations, queues, or shared state — including specific failure shapes like timeout-after-side-effect and duplicate retry delivery.
- **Fail-closed secret handling.** `.env` and credential paths are absolute-deny: not readable into artifacts, not uploadable, no allow flag exists to bypass it.
- **Honest failure states.** Browser automation failures, upload policy blocks, and unavailable gates each have a defined recorded state, and none of them may be reported as a passing review.
- **Durable execution memory.** Multi-stage runs maintain a goal ledger (`GOAL.md` contract + implementation notes with a Resume-Here section) so the workflow survives compaction, interruption, and session handoff.

## Layout

```
skills/pro-review/SKILL.md   the agent-facing protocol (playbooks, gates, escalation policy)
bin/pro-review.mjs           CLI entry point
src/pro-review/              implementation (~3.9k lines, zero runtime dependencies)
  artifacts.mjs / prepare.mjs      packet construction
  scanner.mjs / patterns.mjs       fail-closed secret scanning
  google-drive-publisher.mjs       Drive upload + marker verification
  mcp-server.mjs                   read-only MCP transport for ChatGPT connectors
  response-parser.mjs / cli.mjs    verdict parsing and the gate
  goal-ledger.mjs / workflows.mjs  durable run state and playbook routing
test/pro-review.test.mjs     29 tests (node --test, no framework)
docs/ENGINEERING_DESIGN.md   the full design document this was built from
```

## Setup

```bash
npm install -g .            # exposes the `pro-review` binary
pro-review init             # once per repository → .pro-review/config.json
```

Drive publishing needs a Google OAuth desktop client (`.pro-review/google-oauth-client.json` or `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`); tokens are stored gitignored under `.pro-review/`. The MCP transport needs no Google credentials — set `PRO_REVIEW_MCP_TOKEN` before exposing it through any tunnel.

The skill file is designed for the Codex CLI (`~/.codex/skills/pro-review/`), but the CLI and the protocol are agent-agnostic.
