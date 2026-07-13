import path from "node:path";
import fs from "node:fs/promises";
import { initProject, prepareReview } from "./prepare.mjs";
import { recordResponse } from "./response-parser.mjs";
import { pathExists, readJson } from "./fs-utils.mjs";
import { allModesText } from "./workflows.mjs";
import { createBrief, getNextAction, startPlaybook } from "./playbook-runner.mjs";
import { publishRun } from "./google-drive-publisher.mjs";
import { renderMcpReviewPrompt, startReviewMcpServer } from "./mcp-server.mjs";

export async function main(argv, io = {}) {
  const cwd = io.cwd || process.cwd();
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const [command, ...rest] = argv;
  const options = parseArgs(rest);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    stdout.write(helpText());
    return;
  }

  if (command === "init") {
    const result = await initProject({ cwd });
    stdout.write(`Initialized pro-review in ${result.proReviewDir}\n`);
    stdout.write(`config: ${result.createdConfig ? "created" : "exists"}\n`);
    stdout.write(`state: ${result.createdState ? "created" : "exists"}\n`);
    stdout.write(`gitignore: ${result.gitignoreUpdated ? "updated" : "unchanged"}\n`);
    return;
  }

  if (command === "prepare") {
    const result = await prepareReview({
      cwd,
      mode: required(options, "mode"),
      feature: required(options, "feature"),
      planFile: options["plan-file"]?.[0] || null,
      includes: options.include || [],
      allowFiles: options["allow-file"] || [],
      baseRef: options["base-ref"]?.[0] || null,
      playbook: options.playbook?.[0] || null,
      stage: options.stage?.[0] || null,
      lenses: options.lens || null,
      workName: options["work-name"]?.[0] || null
    });

    stdout.write(renderPrepareSummary(result, cwd));
    return;
  }

  if (command === "brief") {
    const intent = optionText(options, "intent") || positionalText(options) || required(options, "work");
    const result = await createBrief({
      cwd,
      intent,
      playbook: options.playbook?.[0] || null,
      workName: options["work-name"]?.[0] || options.work?.[0] || null,
      overwrite: options.overwrite?.[0] === "true"
    });
    stdout.write(`Created pro-review brief: ${path.relative(cwd, result.brief_path)}\n`);
    stdout.write(`playbook: ${result.playbook}\n`);
    stdout.write(`work: ${result.work_slug}\n`);
    stdout.write(`created: ${result.created}\n`);
    return;
  }

  if (command === "start") {
    const intent = optionText(options, "intent") || positionalText(options) || required(options, "work");
    const result = await startPlaybook({
      cwd,
      intent,
      playbook: options.playbook?.[0] || null,
      workName: options["work-name"]?.[0] || options.work?.[0] || null,
      includes: options.include || [],
      allowFiles: options["allow-file"] || [],
      baseRef: options["base-ref"]?.[0] || null,
      planFile: options["plan-file"]?.[0] || null
    });
    stdout.write(renderStartSummary(result, cwd));
    return;
  }

  if (command === "publish") {
    const runId = await resolveRunId(cwd, options);
    if (!isTruthy(options["confirm-external-upload"]?.[0])) {
      stdout.write(await renderPublishApprovalPrompt({ cwd, runId }));
      const error = new Error("External upload confirmation required. Re-run with --confirm-external-upload after explicit user approval for this run.");
      error.exitCode = 2;
      throw error;
    }

    const result = await publishRun({
      cwd,
      runId,
      onAuthUrl: (url) => {
        stdout.write("Open this URL to authorize Google Drive publishing:\n");
        stdout.write(`${url}\n`);
      }
    });
    stdout.write(`${JSON.stringify(publicPublishResult(result, cwd), null, 2)}\n`);
    return;
  }

  if (command === "mcp") {
    const host = options.host?.[0] || process.env.PRO_REVIEW_MCP_HOST || "127.0.0.1";
    const port = Number(options.port?.[0] || process.env.PRO_REVIEW_MCP_PORT || 8789);
    const token = options.token?.[0] || process.env.PRO_REVIEW_MCP_TOKEN || "";
    await startReviewMcpServer({ cwd, host, port, token, stdout });
    return new Promise(() => {});
  }

  if (command === "mcp-prompt") {
    const runId = await resolveRunId(cwd, options);
    stdout.write(await renderMcpReviewPrompt({ cwd, runId }));
    return;
  }

  if (command === "next") {
    const next = await getNextAction({ cwd });
    stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    return;
  }

  if (command === "record-response") {
    const runId = required(options, "run");
    const responseFile = path.resolve(cwd, required(options, "file"));
    const decision = await recordResponse({ cwd, runId, responseFile });
    stdout.write(`${JSON.stringify(publicDecision(decision, cwd), null, 2)}\n`);
    return;
  }

  if (command === "status") {
    stdout.write(await renderStatus(cwd));
    return;
  }

  stderr.write(`Unknown command: ${command}\n\n`);
  stdout.write(helpText());
  const error = new Error(`Unknown command: ${command}`);
  error.exitCode = 2;
  throw error;
}

export function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) {
      (out._ ||= []).push(token);
      continue;
    }

    const eq = token.indexOf("=");
    if (eq !== -1) {
      const key = token.slice(2, eq);
      const value = token.slice(eq + 1);
      (out[key] ||= []).push(value);
      continue;
    }

    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      (out[key] ||= []).push("true");
    } else {
      (out[key] ||= []).push(next);
      i += 1;
    }
  }
  return out;
}

function required(options, key) {
  const value = options[key]?.[0];
  if (!value) throw new Error(`Missing required --${key}`);
  return value;
}

function optionText(options, key) {
  return options[key]?.join(" ").trim() || "";
}

function positionalText(options) {
  return options._?.join(" ").trim() || "";
}

function isTruthy(value) {
  return value === "true" || value === true || value === "1" || value === "yes";
}

async function resolveRunId(cwd, options) {
  const explicit = options.run?.[0];
  if (explicit && explicit !== "latest") return explicit;

  const statePath = path.join(cwd, ".pro-review", "state.json");
  if (await pathExists(statePath)) {
    const state = await readJson(statePath);
    if (state.last_run_id) return state.last_run_id;
  }

  const runsDir = path.join(cwd, ".pro-review", "runs");
  if (await pathExists(runsDir)) {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const runs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    if (runs[0]) return runs[0];
  }

  throw new Error("No pro-review run found. Run `pro-review start ...` or `pro-review prepare ...` first.");
}

async function renderPublishApprovalPrompt({ cwd, runId }) {
  const runDir = path.join(cwd, ".pro-review", "runs", runId);
  const manifestPath = path.join(runDir, "manifest.json");
  const publishPath = path.join(runDir, "publish.json");
  if (!(await pathExists(manifestPath)) || !(await pathExists(publishPath))) {
    throw new Error(`No prepared pro-review run found for ${runId}.`);
  }

  const [manifest, publish] = await Promise.all([
    readJson(manifestPath),
    readJson(publishPath)
  ]);
  const included = manifest.included_files || [];
  const excluded = manifest.excluded_files || [];
  const totalBytes = included.reduce((sum, file) => sum + (file.size_bytes || 0), 0);
  const lines = [
    "External upload approval required.",
    "",
    "This will upload the generated review_manifest.md and review_bundle.md to Google Drive as native Google Docs for ChatGPT Pro review.",
    `run_id: ${runId}`,
    `mode: ${manifest.mode}`,
    `playbook: ${manifest.workflow?.playbook || "unknown"}`,
    `stage: ${manifest.workflow?.stage || "unknown"}`,
    `destination_folder: ${publish.folder_plan?.path || "unknown"}`,
    `manifest_doc_title: ${publish.manifest_doc?.title || "unknown"}`,
    `bundle_doc_title: ${publish.bundle_doc?.title || "unknown"}`,
    `included_file_count: ${included.length}`,
    `included_total_bytes: ${totalBytes}`,
    `excluded_file_count: ${excluded.length}`,
    "",
    "Included files:"
  ];

  if (included.length === 0) {
    lines.push("- none");
  } else {
    for (const file of included) {
      lines.push(`- ${file.path} (${file.reason || file.kind || "included"}, ${file.size_bytes || 0} bytes${file.truncated ? ", truncated" : ""})`);
    }
  }

  const sensitiveExcluded = excluded.filter((file) => file.sensitive_path).length;
  lines.push("");
  lines.push(`Sensitive excluded paths: ${sensitiveExcluded}`);
  lines.push("Absolute deny rule: .env and .env.* are not read, uploaded, or bypassable.");
  lines.push("");
  lines.push("To proceed, the user must explicitly approve this upload for this run, then run:");
  lines.push("pro-review publish --confirm-external-upload");
  lines.push("");
  lines.push("Equivalent explicit command:");
  lines.push(`pro-review publish --run ${runId} --confirm-external-upload`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function renderStartSummary(result, cwd) {
  const relBrief = path.relative(cwd, result.brief.brief_path);
  const relLedger = path.relative(cwd, result.ledger.ledger_dir);
  const relRunDir = path.relative(cwd, result.run.runDir);
  return [
    `Started pro-review playbook: ${result.workflow.playbook}`,
    `work: ${result.workflow.work_slug}`,
    `stage: ${result.workflow.stage}`,
    `mode: ${result.workflow.mode}`,
    `lenses: ${result.workflow.lenses.join(", ")}`,
    `brief: ${relBrief}`,
    `ledger: ${relLedger}`,
    `run: ${relRunDir}`,
    `prompt: ${path.join(relRunDir, "prompt.md")}`,
    `mcp_prompt: pro-review mcp-prompt --run ${result.run.runId}`,
    `drive_folder: ${result.run.publishMetadata.folder_plan.path}`,
    "",
    "Next: run pro-review mcp and submit the pro-review mcp-prompt output in a fresh ChatGPT Pro chat. Use pro-review publish only when using the Google Drive fallback/archive path.",
    ""
  ].join("\n");
}

function renderPrepareSummary(result, cwd) {
  const relRunDir = path.relative(cwd, result.runDir) || result.runDir;
  const lines = [
    `Prepared pro-review run: ${result.runId}`,
    `run_dir: ${relRunDir}`,
    `prompt: ${path.join(relRunDir, "prompt.md")}`,
    "",
    "Included files:"
  ];

  if (result.includedFiles.length === 0) {
    lines.push("- none");
  } else {
    for (const file of result.includedFiles) {
      lines.push(`- ${file.path} (${file.reason}, ${file.size_bytes} bytes${file.truncated ? ", truncated" : ""})`);
    }
  }

  lines.push("", "Excluded files:");
  if (result.excludedFiles.length === 0) {
    lines.push("- none");
  } else {
    for (const file of result.excludedFiles) {
      lines.push(`- ${file.path} (${file.reason})`);
    }
  }

  lines.push("", "Google Drive publish handoff:");
  lines.push(`- folder_path: ${result.publishMetadata.folder_plan.path}`);
  lines.push(`- manifest_doc_title: ${result.publishMetadata.manifest_doc.title}`);
  lines.push(`- bundle_doc_title: ${result.publishMetadata.bundle_doc.title}`);
  lines.push("- publish_status: local_artifacts_ready");
  lines.push("");
  lines.push("MCP handoff:");
  lines.push("- serve: pro-review mcp");
  lines.push(`- prompt: pro-review mcp-prompt --run ${result.runId}`);
  lines.push("");
  lines.push("Next: use the MCP handoff in a fresh ChatGPT Pro chat. Use pro-review publish only when using the Google Drive fallback/archive path.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

async function renderStatus(cwd) {
  const runsDir = path.join(cwd, ".pro-review", "runs");
  if (!(await pathExists(runsDir))) {
    return "No .pro-review/runs directory found. Run `pro-review init` first.\n";
  }
  const entries = await fs.readdir(runsDir, { withFileTypes: true });
  const runs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  if (runs.length === 0) return "No review runs yet.\n";

  const lines = ["Review runs:"];
  for (const run of runs.slice(0, 20)) {
    const decisionPath = path.join(runsDir, run, "decision.json");
    const manifestPath = path.join(runsDir, run, "manifest.json");
    const decision = (await pathExists(decisionPath)) ? await readJson(decisionPath) : null;
    const manifest = (await pathExists(manifestPath)) ? await readJson(manifestPath) : null;
    const workflow = manifest?.workflow ? `${manifest.workflow.playbook}/${manifest.workflow.stage}` : manifest?.mode;
    lines.push(`- ${run} ${manifest ? `[${workflow}/${manifest.feature_slug}]` : ""} ${decision ? `=> ${decision.verdict}` : "=> pending"}`);
  }
  return `${lines.join("\n")}\n`;
}

function publicDecision(decision, cwd) {
  return {
    verdict: decision.verdict,
    run_id: decision.run_id,
    marker_confirmed: decision.marker_confirmed,
    blocker_count: decision.blocker_count,
    requested_context: decision.requested_context,
    human_escalation_questions: decision.human_escalation_questions,
    invalid_reasons: decision.invalid_reasons,
    policy_overrides: decision.policy_overrides,
    response_path: path.relative(cwd, decision.response_path),
    decision_path: path.relative(cwd, decision.decision_path)
  };
}

function publicPublishResult(result, cwd) {
  return {
    run_id: result.runId,
    run_dir: path.relative(cwd, result.runDir),
    publish_path: path.relative(cwd, result.publishPath),
    status: result.publishMetadata.status,
    verified_marker: result.publishMetadata.verified_marker,
    folder_path: result.publishMetadata.folder_plan.path,
    manifest_doc: {
      title: result.publishMetadata.manifest_doc.title,
      id: result.publishMetadata.manifest_doc.id,
      url: result.publishMetadata.manifest_doc.url
    },
    bundle_doc: {
      title: result.publishMetadata.bundle_doc.title,
      id: result.publishMetadata.bundle_doc.id,
      url: result.publishMetadata.bundle_doc.url
    }
  };
}

function helpText() {
  return `pro-review

Usage:
  pro-review init
  pro-review brief <intent> [--playbook <name>] [--work-name <slug>]
  pro-review start <intent> [--playbook <name>] [--work-name <slug>] [--include <path>...] [--allow-file <path>...]
  pro-review prepare --mode ${allModesText()} --feature <slug> [--playbook <name>] [--stage <stage>] [--lens <name>...] [--base-ref <ref>] [--plan-file <path>] [--include <path>...] [--allow-file <path>...]
  pro-review publish [--run <run-id>|--run latest] [--confirm-external-upload]
  pro-review mcp [--host <host>] [--port <port>] [--token <token>]
  pro-review mcp-prompt [--run <run-id>|--run latest]
  pro-review record-response --run <run-id> --file <response.md>
  pro-review next
  pro-review status

Notes:
  v0 generates deterministic local review artifacts, skill-facing playbook state, a Google Drive handoff, and a read-only MCP transport.
  publish defaults to the latest prepared run; you normally do not need to pass --run.
  Running publish without --confirm-external-upload prints an external-upload preflight and exits before network upload.
  pro-review publish creates or finds pro-review/<repo>/<work>, uploads native Google Docs, and verifies the run marker.
  pro-review mcp serves prepared review runs at /mcp. It exposes only known .pro-review run artifacts, not arbitrary repository files.
  Set PRO_REVIEW_MCP_TOKEN or pass --token before exposing the MCP endpoint through a public tunnel.
  The pro-review skill should use the Codex in-app browser to submit prompt.md into a fresh ChatGPT Pro chat and record the response automatically.
  Manual fallback is only for browser/auth failures: publish the Docs, paste prompt.md, save the response, then run record-response.
`;
}
