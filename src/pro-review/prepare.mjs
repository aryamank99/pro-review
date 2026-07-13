import path from "node:path";
import fs from "node:fs/promises";
import {
  ARTIFACT_VERSION,
  COMMON_CONTEXT_FILES,
  DEFAULT_CONFIG,
  VALID_MODES
} from "./constants.mjs";
import { getGitInfo } from "./git.mjs";
import { buildManifest, buildPublishMetadata, writeRunArtifacts } from "./artifacts.mjs";
import {
  ensureDir,
  listFilesRecursive,
  pathExists,
  randomHex,
  readFileBuffer,
  readJson,
  resolveInside,
  sha256,
  slugify,
  utcStamp,
  writeJson
} from "./fs-utils.mjs";
import { classifyPath, scanBuffer } from "./scanner.mjs";
import { matchesAnyPattern } from "./patterns.mjs";
import { resolveWorkflow, validateLenses } from "./workflows.mjs";

export async function initProject({ cwd }) {
  const proReviewDir = path.join(cwd, ".pro-review");
  const runsDir = path.join(proReviewDir, "runs");
  const configPath = path.join(proReviewDir, "config.json");
  const statePath = path.join(proReviewDir, "state.json");
  const repoSlug = slugify(path.basename(cwd));

  await ensureDir(runsDir);

  let createdConfig = false;
  if (!(await pathExists(configPath))) {
    await writeJson(configPath, { ...DEFAULT_CONFIG, repoSlug });
    createdConfig = true;
  }

  let createdState = false;
  if (!(await pathExists(statePath))) {
    await writeJson(statePath, {
      schema_version: "pro-review-state/v0",
      created_at: new Date().toISOString(),
      last_run_id: null
    });
    createdState = true;
  }

  const gitignorePath = path.join(cwd, ".gitignore");
  let gitignoreUpdated = false;
  const entries = [
    ".pro-review/runs/",
    ".pro-review/google-drive-token.json",
    ".pro-review/google-oauth-client.json"
  ];
  const existing = (await pathExists(gitignorePath)) ? await fs.readFile(gitignorePath, "utf8") : "";
  const existingLines = new Set(existing.split(/\r?\n/));
  const missingEntries = entries.filter((entry) => !existingLines.has(entry));
  if (missingEntries.length > 0) {
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    await fs.writeFile(gitignorePath, `${existing}${prefix}${missingEntries.join("\n")}\n`, "utf8");
    gitignoreUpdated = true;
  }

  return { proReviewDir, runsDir, configPath, statePath, createdConfig, createdState, gitignoreUpdated };
}

export async function prepareReview({
  cwd,
  mode,
  feature,
  planFile,
  includes = [],
  allowFiles = [],
  baseRef = null,
  playbook = null,
  stage = null,
  lenses = null,
  workName = null,
  goalLedger = null
}) {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid mode "${mode}". Expected one of: ${[...VALID_MODES].join(", ")}`);
  }
  if (!feature) {
    throw new Error("Missing required --feature <feature-slug>");
  }
  if (mode === "plan" && !planFile) {
    throw new Error("Plan reviews require --plan-file <path>");
  }

  await initProject({ cwd });
  const configPath = path.join(cwd, ".pro-review", "config.json");
  const statePath = path.join(cwd, ".pro-review", "state.json");
  const config = await loadConfig(configPath, cwd);
  const repoSlug = slugify(config.repoSlug || path.basename(cwd));
  const featureSlug = slugify(feature, "feature");
  const resolvedWorkflow = resolveWorkflow({
    intent: workName || feature,
    playbook,
    workName: workName || feature,
    mode
  });
  const workflow = {
    playbook: resolvedWorkflow.playbook,
    stage: stage || resolvedWorkflow.stage,
    work_name: resolvedWorkflow.work_name,
    work_slug: resolvedWorkflow.work_slug,
    lenses: validateLenses(lenses || resolvedWorkflow.lenses),
    goal_mode_policy: resolvedWorkflow.goal_mode_policy,
    goal_ledger: goalLedger
      ? {
        work_id: goalLedger.work_id,
        goal_path: goalLedger.goal_path,
        notes_path: goalLedger.notes_path
      }
      : null
  };
  const generatedAt = new Date().toISOString();
  const runId = `${utcStamp(new Date())}_${randomHex(2)}`;
  const artifactMarker = `pro_review_marker_${randomHex(12)}`;
  const runDir = path.join(cwd, ".pro-review", "runs", runId);

  const gitInfo = await getGitInfo(cwd, baseRef || config.baseRef || null);
  if (!gitInfo.diff_hash) {
    gitInfo.diff_hash = sha256(`${generatedAt}:${featureSlug}:${includes.join(",")}`);
  }

  const allowSet = new Set(allowFiles.map((file) => resolveInside(cwd, file).relativePath));
  const candidates = await selectCandidateFiles({ cwd, mode, planFile, includes, gitInfo });
  const { includedFiles, excludedFiles } = await materializeIncludedFiles({
    cwd,
    candidates,
    config,
    allowSet
  });
  gitInfo.diff_hash = sha256(JSON.stringify({
    git_diff_hash: gitInfo.diff_hash,
    status: gitInfo.status,
    selected_files: includedFiles.map((file) => ({ path: file.path, sha256: file.sha256 })),
    excluded_files: excludedFiles.map((file) => ({ path: file.path, reason: file.reason }))
  }));

  const publishMetadata = buildPublishMetadata({ repoSlug, featureSlug, runId, config });
  const manifest = buildManifest({
    runId,
    repoSlug,
    featureSlug,
    mode,
    workflow,
    generatedAt,
    artifactMarker,
    gitInfo,
    config,
    includedFiles,
    excludedFiles
  });

  await ensureDir(runDir);
  await writeRunArtifacts(runDir, manifest, includedFiles, publishMetadata);
  await writeJson(statePath, {
    schema_version: "pro-review-state/v0",
    updated_at: new Date().toISOString(),
    last_run_id: runId,
    last_work_id: workflow.work_slug,
    last_playbook: workflow.playbook,
    last_stage: workflow.stage
  });

  return {
    runId,
    runDir,
    manifest,
    publishMetadata,
    includedFiles: includedFiles.map(({ content, ...file }) => file),
    excludedFiles,
    promptPath: path.join(runDir, "prompt.md")
  };
}

async function loadConfig(configPath, cwd) {
  const loaded = await readJson(configPath);
  return mergeConfig({ ...DEFAULT_CONFIG, repoSlug: slugify(path.basename(cwd)) }, loaded);
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    drive: {
      ...base.drive,
      ...(override.drive || {})
    },
    chatgpt: {
      ...base.chatgpt,
      ...(override.chatgpt || {})
    },
    context: {
      ...base.context,
      ...(override.context || {})
    },
    gates: {
      ...base.gates,
      ...(override.gates || {})
    }
  };
}

async function selectCandidateFiles({ cwd, mode, planFile, includes, gitInfo }) {
  const candidates = new Map();
  const add = (userPath, kind, reason, explicit = false, deleted = false) => {
    const resolved = resolveInside(cwd, userPath);
    if (resolved.relativePath === ".") return;
    const existing = candidates.get(resolved.relativePath);
    if (existing?.explicit && !explicit) return;
    candidates.set(resolved.relativePath, {
      path: resolved.relativePath,
      absolutePath: resolved.absolutePath,
      kind,
      reason,
      explicit,
      deleted
    });
  };

  if (mode === "plan" && planFile) {
    add(planFile, "plan", "plan-file", true);
  }

  for (const file of includes) {
    add(file, inferKind(file), "explicit-include", true);
  }

  if (mode !== "plan") {
    for (const file of gitInfo.changedFiles) {
      const reason = gitInfo.untrackedFiles.includes(file)
        ? "untracked-file"
        : gitInfo.committedDeletedFiles.includes(file)
          ? "committed-deletion"
          : gitInfo.committedFiles.includes(file) && (gitInfo.unstagedFiles.includes(file) || gitInfo.stagedFiles.includes(file))
            ? "committed-change+working-tree-change"
        : gitInfo.committedFiles.includes(file)
          ? "committed-change"
          : "changed-file";
      add(file, inferKind(file), reason, false, gitInfo.committedDeletedFiles.includes(file));
    }
    for (const common of COMMON_CONTEXT_FILES) {
      if (await pathExists(path.join(cwd, common))) {
        add(common, inferKind(common), "common-context", false);
      }
    }
  }

  return [...candidates.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function materializeIncludedFiles({ cwd, candidates, config, allowSet }) {
  const includedFiles = [];
  const excludedFiles = [];
  const sizeBudget = config.context?.sizeBudgetBytes || 250000;
  const perFileBudget = config.context?.perFileBudgetBytes || 60000;
  let usedBytes = 0;

  for (const candidate of candidates) {
    const includeRules = config.context?.include || [];
    if (!candidate.explicit && includeRules.length > 0 && !matchesAnyPattern(candidate.path, includeRules)) {
      excludedFiles.push({ path: candidate.path, reason: "not_in_include_rules", sensitive_path: false });
      continue;
    }

    const pathScan = classifyPath(candidate.path, config.context?.exclude || [], allowSet);
    if (!pathScan.ok) {
      excludedFiles.push({ path: pathScan.path, reason: pathScan.reason, sensitive_path: pathScan.sensitive_path });
      continue;
    }

    if (candidate.deleted) {
      const content = "[File deleted in committed diff. No current file contents are available.]\n";
      includedFiles.push({
        path: candidate.path,
        kind: candidate.kind,
        reason: candidate.reason,
        size_bytes: 0,
        sha256: sha256(content),
        truncated: false,
        content
      });
      usedBytes += Buffer.byteLength(content);
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(candidate.absolutePath);
    } catch {
      excludedFiles.push({ path: candidate.path, reason: "missing", sensitive_path: false });
      continue;
    }

    if (stat.isDirectory()) {
      const nested = await listFilesRecursive(cwd, candidate.path);
      for (const entry of nested.filter((item) => item.type === "file")) {
        candidates.push({
          path: entry.relativePath,
          absolutePath: entry.absolutePath,
          kind: inferKind(entry.relativePath),
          reason: `${candidate.reason}:directory`,
          explicit: candidate.explicit,
          deleted: false
        });
      }
      continue;
    }

    if (!stat.isFile()) {
      excludedFiles.push({ path: candidate.path, reason: "unsupported", sensitive_path: false });
      continue;
    }

    const buffer = await readFileBuffer(candidate.absolutePath);
    const contentScan = scanBuffer(candidate.path, buffer, allowSet);
    if (!contentScan.ok) {
      excludedFiles.push({ path: contentScan.path, reason: contentScan.reason, sensitive_path: contentScan.sensitive_path });
      continue;
    }

    if (usedBytes >= sizeBudget) {
      excludedFiles.push({ path: candidate.path, reason: "size_budget", sensitive_path: false });
      continue;
    }

    const remaining = sizeBudget - usedBytes;
    const limit = Math.min(perFileBudget, remaining);
    const truncated = buffer.length > limit;
    const contentBuffer = truncated ? buffer.subarray(0, limit) : buffer;
    const content = contentBuffer.toString("utf8");

    includedFiles.push({
      path: candidate.path,
      kind: candidate.kind,
      reason: candidate.reason,
      size_bytes: buffer.length,
      sha256: sha256(buffer),
      truncated,
      content
    });
    usedBytes += contentBuffer.length;
  }

  return { includedFiles, excludedFiles };
}

function inferKind(filePath) {
  const lower = filePath.toLowerCase();
  if (/test|spec/.test(lower)) return "test";
  if (/package\.json|tsconfig|jsconfig|config/.test(lower)) return "config";
  if (/plan|brief|design|readme|\.md$/.test(lower)) return "plan";
  if (/dist|build|generated/.test(lower)) return "generated";
  return "source";
}
