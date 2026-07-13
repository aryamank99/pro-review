import path from "node:path";
import fs from "node:fs/promises";
import { ensureDir, pathExists, slugify, writeText } from "./fs-utils.mjs";

export async function ensureGoalLedger({
  cwd,
  workId,
  title,
  objective,
  playbook,
  stage,
  status = "doing",
  nextAction = "Continue the pro-review playbook."
}) {
  const safeWorkId = slugify(workId || title || objective || "pro-review-work", "pro-review-work");
  const agentDir = path.join(cwd, ".agent");
  const runsDir = path.join(agentDir, "runs");
  const ledgerDir = path.join(runsDir, safeWorkId);
  const evidenceDir = path.join(ledgerDir, "evidence");
  const goalPath = path.join(ledgerDir, "GOAL.md");
  const notesPath = path.join(ledgerDir, "implementation-notes.html");
  const indexPath = path.join(agentDir, "GOALS.md");
  const now = new Date().toISOString();

  await ensureDir(evidenceDir);

  const goalExists = await pathExists(goalPath);
  if (!goalExists) {
    await writeText(goalPath, renderGoal({
      workId: safeWorkId,
      title: title || safeWorkId,
      objective: objective || title || safeWorkId,
      playbook,
      createdAt: now,
      notesPath
    }));
  }

  const notesExists = await pathExists(notesPath);
  if (!notesExists) {
    await writeText(notesPath, renderImplementationNotes({
      workId: safeWorkId,
      title: title || safeWorkId,
      objective: objective || title || safeWorkId,
      playbook,
      stage,
      status,
      nextAction,
      createdAt: now
    }));
  }

  await upsertGoalIndex(indexPath, {
    workId: safeWorkId,
    title: title || safeWorkId,
    status,
    playbook,
    ledgerDir
  });

  return {
    work_id: safeWorkId,
    ledger_dir: ledgerDir,
    goal_path: goalPath,
    notes_path: notesPath,
    evidence_dir: evidenceDir,
    created_goal: !goalExists,
    created_notes: !notesExists
  };
}

export async function appendLedgerCheckpoint({ notesPath, status, phase, summary, evidence = [] }) {
  if (!(await pathExists(notesPath))) return false;
  const html = await fs.readFile(notesPath, "utf8");
  const event = {
    ts: new Date().toISOString(),
    status,
    phase,
    actor: "agent",
    summary,
    evidence
  };
  const closeMarker = "\n    ];";
  const insertAt = html.indexOf(closeMarker);
  if (insertAt === -1) return false;
  const prefix = html.slice(0, insertAt).trimEnd();
  const suffix = html.slice(insertAt);
  const separator = prefix.endsWith("[") ? "\n" : ",\n";
  await fs.writeFile(notesPath, `${prefix}${separator}${JSON.stringify(event, null, 2)}${suffix}`, "utf8");
  return true;
}

function renderGoal({ workId, title, objective, playbook, createdAt, notesPath }) {
  return `# ${title}

## Objective

${objective}

## Finishing Criteria

- [todo] Required Pro review stages for the ${playbook} playbook are complete.
- [todo] Blocking findings are fixed, waived with rationale, or escalated.
- [todo] Relevant validation has run or residual risk is recorded.
- [todo] Final state is captured in implementation-notes.html.

## Playbook

- work_id: ${workId}
- playbook: ${playbook}
- created_at: ${createdAt}

## Goal Mode Coupling

Maintain the agent-owned ledger at ${path.dirname(notesPath)} and keep implementation-notes.html current at checkpoints, before compaction, and before final handoff.

## Escape Hatch

Pause, ask the user, or mark a scoped item [blocked] / [incomplete] if:

- validation contradicts the goal
- the goal requires a scope change
- the agent is looping without measurable progress
- the next step risks deleting or rewriting durable memory
- the plan and actual repo disagree
- the ledger itself contaminates validation
`;
}

function renderImplementationNotes({ workId, title, objective, playbook, stage, status, nextAction, createdAt }) {
  const initialEvent = {
    ts: createdAt,
    status,
    phase: stage,
    actor: "agent",
    summary: `Started ${playbook} playbook for ${title}.`,
    evidence: []
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)} - Pro Review Ledger</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; max-width: 920px; margin: 40px auto; padding: 0 20px; color: #1f2933; }
    h1, h2 { line-height: 1.2; }
    code { background: #eef2f7; padding: 1px 4px; border-radius: 4px; }
    .box { border: 1px solid #cfd8e3; border-radius: 8px; padding: 16px; margin: 16px 0; }
    .muted { color: #52606d; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="muted">work_id: <code>${escapeHtml(workId)}</code> | playbook: <code>${escapeHtml(playbook)}</code></p>

  <h2>Resume Here</h2>
  <div class="box">
    <p><strong>Status:</strong> [${escapeHtml(status)}]</p>
    <p><strong>Current phase:</strong> ${escapeHtml(stage)}</p>
    <p><strong>Objective:</strong> ${escapeHtml(objective)}</p>
    <p><strong>Completed work:</strong> none yet</p>
    <p><strong>Active work:</strong> ${escapeHtml(stage)}</p>
    <p><strong>Blockers:</strong> none known</p>
    <p><strong>Next exact action:</strong> ${escapeHtml(nextAction)}</p>
    <p><strong>Last validation:</strong> not run</p>
    <p><strong>Protected paths and user-owned work:</strong> do not overwrite user changes without approval</p>
  </div>

  <h2>Decisions And Tradeoffs</h2>
  <ul>
    <li>[todo] Record decisions that were not explicit in the request.</li>
  </ul>

  <h2>Pro Review Runs</h2>
  <ul>
    <li>[todo] Link .pro-review run decisions, prompts, and Drive Docs as they are created.</li>
  </ul>

  <h2>Validation</h2>
  <ul>
    <li>[todo] Record verification commands, results, skipped checks, and residual risk.</li>
  </ul>

  <h2>Progress Timeline</h2>
  <div id="timeline"></div>

  <script>
    const progressEvents = [
${JSON.stringify(initialEvent, null, 2)}
    ];

    const timeline = document.getElementById("timeline");
    timeline.innerHTML = "<ul>" + progressEvents.map((event) => {
      return "<li><strong>" + event.ts + "</strong> [" + event.status + "] " + event.phase + " - " + event.summary + "</li>";
    }).join("") + "</ul>";
  </script>
</body>
</html>
`;
}

async function upsertGoalIndex(indexPath, { workId, title, status, playbook, ledgerDir }) {
  const entry = `- [${status}] ${workId} - ${title} (${playbook}) - ${ledgerDir}`;
  let content = "# Goals\n\n";
  if (await pathExists(indexPath)) {
    content = await fs.readFile(indexPath, "utf8");
    const lines = content.split(/\r?\n/).filter((line) => !line.includes(` ${workId} - `));
    content = `${lines.join("\n").replace(/\s+$/, "")}\n`;
    if (!content.startsWith("# Goals")) content = `# Goals\n\n${content}`;
  }
  await writeText(indexPath, `${content.trimEnd()}\n${entry}\n`);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
