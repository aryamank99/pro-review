import path from "node:path";
import { ensureGoalLedger } from "./goal-ledger.mjs";
import { ensureDir, pathExists, readJson, writeText } from "./fs-utils.mjs";
import { prepareReview, initProject } from "./prepare.mjs";
import { getPlaybook, resolveWorkflow } from "./workflows.mjs";

export async function createBrief({ cwd, playbook, workName, intent = "", overwrite = false }) {
  const workflow = resolveWorkflow({ intent, playbook, workName });
  const briefsDir = path.join(cwd, ".pro-review", "briefs");
  const briefPath = path.join(briefsDir, `${workflow.work_slug}.${workflow.playbook}.md`);
  await initProject({ cwd });
  await ensureDir(briefsDir);

  if (!overwrite && await pathExists(briefPath)) {
    return { ...workflow, brief_path: briefPath, created: false };
  }

  await writeText(briefPath, renderBrief({ workflow, intent }));
  return { ...workflow, brief_path: briefPath, created: true };
}

export async function startPlaybook({
  cwd,
  intent,
  playbook = null,
  workName = null,
  includes = [],
  allowFiles = [],
  baseRef = null,
  planFile = null
}) {
  const workflow = resolveWorkflow({ intent, playbook, workName });
  const brief = await createBrief({
    cwd,
    playbook: workflow.playbook,
    workName: workflow.work_name,
    intent
  });
  const ledger = await ensureGoalLedger({
    cwd,
    workId: workflow.work_slug,
    title: workflow.work_name,
    objective: intent || workflow.work_name,
    playbook: workflow.playbook,
    stage: workflow.stage,
    nextAction: "Serve the generated Pro review packet through read-only MCP, then use the Codex in-app browser to start a fresh ChatGPT Pro chat, submit the MCP launcher prompt, capture the response, and record the gate decision."
  });
  const reviewPlanFile = workflow.mode === "plan" ? (planFile || brief.brief_path) : planFile;
  const reviewIncludes = workflow.mode === "plan"
    ? includes
    : [...new Set([brief.brief_path, ...includes])];

  const run = await prepareReview({
    cwd,
    mode: workflow.mode,
    feature: workflow.work_slug,
    planFile: reviewPlanFile,
    includes: reviewIncludes,
    allowFiles,
    baseRef,
    playbook: workflow.playbook,
    stage: workflow.stage,
    lenses: workflow.lenses,
    workName: workflow.work_name,
    goalLedger: ledger
  });

  return {
    workflow,
    drive_folder: run.publishMetadata.folder_plan,
    brief,
    ledger,
    run
  };
}

export async function getNextAction({ cwd }) {
  const statePath = path.join(cwd, ".pro-review", "state.json");
  if (!(await pathExists(statePath))) {
    return {
      status: "not_initialized",
      next_action: "Run pro-review through the skill for a new playbook; the skill will initialize .pro-review first."
    };
  }

  const state = await readJson(statePath);
  if (!state.last_run_id) {
    return {
      status: "no_runs",
      next_action: "Start a pro-review playbook for the work you want to plan, audit, debug, migrate, or refactor."
    };
  }

  const runDir = path.join(cwd, ".pro-review", "runs", state.last_run_id);
  const decisionPath = path.join(runDir, "decision.json");
  const publishPath = path.join(runDir, "publish.json");
  const promptPath = path.join(runDir, "prompt.md");

  if (!(await pathExists(decisionPath))) {
    const publish = await readJson(publishPath).catch(() => null);
    if (!publish?.verified_marker) {
      return {
        status: "needs_review_transport",
        run_id: state.last_run_id,
        next_action: "Run pro-review mcp, then submit `pro-review mcp-prompt --run <run-id>` output in a fresh ChatGPT Pro chat. Use pro-review publish only for the Google Drive fallback/archive path.",
        prompt_path: promptPath
      };
    }
    return {
      status: "needs_response",
      run_id: state.last_run_id,
      next_action: "Use the pro-review browser loop to start or continue the run chat, submit the MCP or Drive prompt, save the completed response, then record it with pro-review record-response.",
      prompt_path: promptPath
    };
  }

  const decision = await readJson(decisionPath);
  if (decision.verdict === "PASS") {
    return {
      status: "passed",
      run_id: state.last_run_id,
      verdict: decision.verdict,
      next_action: "Proceed to the next playbook stage or final handoff."
    };
  }
  if (decision.verdict === "PASS_WITH_NOTES") {
    return {
      status: "passed_with_notes",
      run_id: state.last_run_id,
      verdict: decision.verdict,
      next_action: "Review non-blocking concerns, update the ledger, then proceed if risk is acceptable."
    };
  }
  if (decision.verdict === "NEEDS_CONTEXT") {
    return {
      status: "needs_context",
      run_id: state.last_run_id,
      verdict: decision.verdict,
      next_action: "Create a requested-context packet with the exact files, symbols, logs, tests, or requirements Pro requested."
    };
  }
  if (decision.verdict === "NEEDS_HUMAN") {
    return {
      status: "needs_human",
      run_id: state.last_run_id,
      verdict: decision.verdict,
      next_action: "Ask the user for the human decision before continuing."
    };
  }
  return {
    status: "blocked",
    run_id: state.last_run_id,
    verdict: decision.verdict,
    next_action: "Fix blockers, validate locally, update the ledger, then request another Pro review."
  };
}

function renderBrief({ workflow, intent }) {
  const playbook = getPlaybook(workflow.playbook);
  return `# ${workflow.work_name}

playbook: ${workflow.playbook}
stage: ${workflow.stage}
mode: ${workflow.mode}
lenses: ${workflow.lenses.join(", ")}

## Original Request

${intent || workflow.work_name}

## Goal

TODO: State the outcome this work should achieve.

## Non-Goals

TODO: List behavior or scope that should not change.

## Acceptance Criteria

- TODO: Add objective completion criteria.

## Constraints

- TODO: Add product, technical, operational, data, security, or rollout constraints.

## Existing Behavior To Preserve

- TODO: Note current behavior that must remain stable.

## Relevant Context

- TODO: Add important files, symbols, docs, logs, tests, or external documentation.

## Human Decisions Required

- TODO: Add decisions the agent cannot infer safely.

## Validation Expectations

- TODO: Add expected tests, builds, dry-runs, smoke checks, or monitoring.

## Playbook Guidance

${playbook.intent}
`;
}
