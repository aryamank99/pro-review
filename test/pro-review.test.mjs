import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { initProject, prepareReview } from "../src/pro-review/prepare.mjs";
import { recordResponse } from "../src/pro-review/response-parser.mjs";
import { pathExists, readJson, sha256, slugify } from "../src/pro-review/fs-utils.mjs";
import { startPlaybook, getNextAction } from "../src/pro-review/playbook-runner.mjs";
import { resolveWorkflow } from "../src/pro-review/workflows.mjs";
import { publishRun } from "../src/pro-review/google-drive-publisher.mjs";
import { callReviewMcpTool, renderMcpReviewPrompt, startReviewMcpServer } from "../src/pro-review/mcp-server.mjs";
import { main } from "../src/pro-review/cli.mjs";

const execFileAsync = promisify(execFile);

test("init creates config, state, runs directory, and gitignore entry", async () => {
  const cwd = await tempDir();

  const first = await initProject({ cwd });
  const second = await initProject({ cwd });

  assert.equal(first.createdConfig, true);
  assert.equal(first.createdState, true);
  assert.equal(second.createdConfig, false);
  assert.equal(second.createdState, false);
  assert.equal(await pathExists(path.join(cwd, ".pro-review", "config.json")), true);
  assert.equal(await pathExists(path.join(cwd, ".pro-review", "state.json")), true);
  assert.equal(await pathExists(path.join(cwd, ".pro-review", "runs")), true);
  const config = await readJson(path.join(cwd, ".pro-review", "config.json"));
  assert.equal(config.chatgpt.browserSurface, "codex-in-app-browser");
  assert.equal(config.chatgpt.newChatPolicy, "per-review-run");

  const gitignore = await fs.readFile(path.join(cwd, ".gitignore"), "utf8");
  assert.equal(gitignore.split(/\r?\n/).filter((line) => line === ".pro-review/runs/").length, 1);
  assert.equal(gitignore.includes(".pro-review/google-drive-token.json"), true);
  assert.equal(gitignore.includes(".pro-review/google-oauth-client.json"), true);
});

test("workflow router infers high-level playbooks from natural language", () => {
  assert.equal(resolveWorkflow({ intent: "use pro-review to build out Google Drive publishing" }).playbook, "feature");
  assert.equal(resolveWorkflow({ intent: "use pro-review to review billing infra" }).playbook, "audit");
  assert.equal(resolveWorkflow({ intent: "use pro-review to debug webhook timeout failure" }).playbook, "debug");
  assert.equal(resolveWorkflow({ intent: "use pro-review to backfill missing invoices" }).playbook, "migration");
  assert.equal(resolveWorkflow({ intent: "use pro-review to refactor billing services" }).playbook, "refactor");
});

test("startPlaybook creates brief, goal ledger, first run, and lens-aware prompt", async () => {
  const cwd = await tempDir();
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "billing.mjs"), "export const billing = true;\n", "utf8");

  const result = await startPlaybook({
    cwd,
    intent: "use pro-review to review billing infra",
    includes: ["src/billing.mjs"]
  });

  assert.equal(result.workflow.playbook, "audit");
  assert.equal(result.workflow.mode, "audit");
  assert.equal(result.run.manifest.mode, "audit");
  assert.equal(result.run.manifest.workflow.playbook, "audit");
  assert.equal(result.run.manifest.workflow.stage, "audit-review");
  assert.equal(await pathExists(result.brief.brief_path), true);
  assert.equal(await pathExists(result.ledger.goal_path), true);
  assert.equal(await pathExists(result.ledger.notes_path), true);
  assert.equal(result.run.includedFiles.some((file) => file.path === "src/billing.mjs"), true);

  const prompt = await fs.readFile(result.run.promptPath, "utf8");
  assert.match(prompt, /Playbook: audit/);
  assert.match(prompt, /Stage: audit-review/);
  assert.match(prompt, /architecture: Review module boundaries/);
  assert.match(prompt, /code-structure: Review orchestration versus reusable mechanics/);

  const notes = await fs.readFile(result.ledger.notes_path, "utf8");
  assert.match(notes, /Resume Here/);
  assert.match(notes, /audit-review/);
});

test("next reports MCP as the next action for an unrecorded started run", async () => {
  const cwd = await tempDir();
  const result = await startPlaybook({
    cwd,
    intent: "use pro-review to build out retry logic"
  });

  const next = await getNextAction({ cwd });

  assert.equal(next.status, "needs_review_transport");
  assert.equal(next.run_id, result.run.runId);
  assert.match(next.next_action, /pro-review mcp/);
  assert.match(next.next_action, /fresh ChatGPT Pro chat/);
});

test("prepare plan generates artifacts, includes plan, and excludes sensitive explicit includes", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nImplement a focused test feature.\n", "utf8");
  await fs.writeFile(path.join(cwd, ".env.local"), "OPENAI_API_KEY=sk-thisShouldNotBeShared1234567890\n", "utf8");

  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "Drive Review Gate",
    planFile: "PLAN.md",
    includes: [".env.local"],
    allowFiles: []
  });

  assert.equal(result.manifest.mode, "plan");
  assert.equal(result.includedFiles.some((file) => file.path === "PLAN.md"), true);
  assert.equal(result.excludedFiles.some((file) => file.reason === "forbidden_env_file" && file.sensitive_path === true), true);
  assert.equal(await pathExists(path.join(result.runDir, "review_manifest.md")), true);
  assert.equal(await pathExists(path.join(result.runDir, "review_bundle.md")), true);
  assert.equal(await pathExists(path.join(result.runDir, "prompt.md")), true);

  const prompt = await fs.readFile(path.join(result.runDir, "prompt.md"), "utf8");
  assert.match(prompt, /@Google Drive read the Google Docs named PROREVIEW__/);
  assert.match(prompt, new RegExp(result.manifest.artifact_marker));

  const publish = await readJson(path.join(result.runDir, "publish.json"));
  assert.equal(publish.status, "local_artifacts_ready");
  assert.equal(publish.verified_marker, false);
  assert.match(publish.folder_plan.path, /^pro-review\/pro-review-test-[^/]+\/drive-review-gate$/);
  assert.deepEqual(publish.folder_plan.folder_names, publish.folder_plan.path.split("/"));
  assert.equal(publish.manifest_doc.folder_path, publish.folder_plan.path);
});

test("prepare never includes env files even when explicitly allowed", async () => {
  const cwd = await tempDir();
  const secretValue = "env_forbidden_marker_2026_05_28";
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nCheck absolute env denial.\n", "utf8");
  await fs.writeFile(path.join(cwd, ".env.local"), `PRIVATE_TOKEN=${secretValue}\n`, "utf8");

  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "env-deny",
    planFile: "PLAN.md",
    includes: [".env.local"],
    allowFiles: [".env.local"]
  });

  assert.equal(result.includedFiles.some((file) => file.path === ".env.local"), false);
  assert.equal(result.excludedFiles.some((file) => (
    file.path === "[sensitive-path-redacted]"
      && file.reason === "forbidden_env_file"
      && file.sensitive_path === true
  )), true);

  const bundle = await fs.readFile(path.join(result.runDir, "review_bundle.md"), "utf8");
  assert.equal(bundle.includes(secretValue), false);
  assert.equal(bundle.includes("PRIVATE_TOKEN"), false);
});

test("publishRun creates Drive folders, uploads native Docs, verifies markers, and records IDs", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nPublish through Drive API.\n", "utf8");
  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "Drive Publisher",
    planFile: "PLAN.md",
    includes: [],
    allowFiles: []
  });
  await fs.writeFile(path.join(cwd, ".pro-review", "google-drive-token.json"), JSON.stringify({
    access_token: "test-access-token",
    expires_at: Date.now() + 600000
  }), "utf8");

  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const parsed = new URL(String(url));
    if (parsed.hostname === "www.googleapis.com" && parsed.pathname === "/drive/v3/files" && options.method !== "POST") {
      return jsonResponse({ files: [] });
    }
    if (parsed.hostname === "www.googleapis.com" && parsed.pathname === "/drive/v3/files" && options.method === "POST") {
      const metadata = JSON.parse(options.body);
      return jsonResponse({
        id: `folder-${metadata.name}`,
        name: metadata.name,
        mimeType: metadata.mimeType,
        parents: metadata.parents || ["root"]
      });
    }
    if (parsed.hostname === "www.googleapis.com" && parsed.pathname === "/upload/drive/v3/files") {
      const body = String(options.body);
      const title = body.match(/"name":"([^"]+)"/)?.[1];
      const isManifest = title.includes("REVIEW_MANIFEST");
      return jsonResponse({
        id: isManifest ? "manifest-doc-id" : "bundle-doc-id",
        name: title,
        mimeType: "application/vnd.google-apps.document",
        webViewLink: `https://docs.google.com/document/d/${isManifest ? "manifest-doc-id" : "bundle-doc-id"}/edit`,
        parents: [`folder-${slugify(path.basename(cwd))}`]
      });
    }
    if (parsed.hostname === "www.googleapis.com" && parsed.pathname.endsWith("/export")) {
      return textResponse(`artifact_marker: ${result.manifest.artifact_marker}\n`);
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  };

  const published = await publishRun({
    cwd,
    runId: result.runId,
    fetchImpl: fakeFetch,
    onAuthUrl: () => {
      throw new Error("OAuth should not run when a fresh token exists.");
    }
  });
  const publish = await readJson(path.join(result.runDir, "publish.json"));

  assert.equal(published.publishMetadata.status, "published");
  assert.equal(publish.status, "published");
  assert.equal(publish.verified_marker, true);
  assert.equal(publish.folder_plan.path, `pro-review/${slugify(path.basename(cwd))}/drive-publisher`);
  assert.deepEqual(publish.folder_plan.folder_ids.map((folder) => folder.name), [
    "pro-review",
    slugify(path.basename(cwd)),
    "drive-publisher"
  ]);
  assert.equal(publish.manifest_doc.id, "manifest-doc-id");
  assert.equal(publish.bundle_doc.id, "bundle-doc-id");
  assert.equal(publish.manifest_doc.folder_id, "folder-drive-publisher");
  assert.equal(publish.bundle_doc.folder_id, "folder-drive-publisher");
  assert.equal(calls.some((call) => String(call.url).includes("uploadType=multipart")), true);
});

test("CLI publish without confirmation prints upload preflight and does not upload", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nReview upload consent.\n", "utf8");
  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "upload-consent",
    planFile: "PLAN.md",
    includes: [],
    allowFiles: []
  });
  let stdout = "";
  let stderr = "";

  await assert.rejects(
    main(["publish"], {
      cwd,
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } }
    }),
    (error) => {
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /External upload confirmation required/);
      return true;
    }
  );

  const publish = await readJson(path.join(result.runDir, "publish.json"));
  assert.equal(publish.status, "local_artifacts_ready");
  assert.equal(publish.verified_marker, false);
  assert.match(stdout, /External upload approval required/);
  assert.match(stdout, new RegExp(`run_id: ${result.runId}`));
  assert.match(stdout, /included_file_count: 1/);
  assert.match(stdout, /pro-review publish --confirm-external-upload/);
  assert.match(stdout, new RegExp(`pro-review publish --run ${result.runId} --confirm-external-upload`));
  assert.equal(stderr, "");
});

test("CLI publish can resolve latest run explicitly", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nReview latest publish.\n", "utf8");
  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "latest-publish",
    planFile: "PLAN.md",
    includes: [],
    allowFiles: []
  });
  let stdout = "";

  await assert.rejects(
    main(["publish", "--run", "latest"], {
      cwd,
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: () => {} }
    }),
    /External upload confirmation required/
  );

  assert.match(stdout, new RegExp(`run_id: ${result.runId}`));
  assert.match(stdout, /pro-review publish --confirm-external-upload/);
});

test("record-response accepts a marker-confirmed PASS response", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nShip a small feature.\n", "utf8");
  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "pass-case",
    planFile: "PLAN.md",
    includes: [],
    allowFiles: []
  });

  const responsePath = path.join(cwd, "response-pass.md");
  await fs.writeFile(responsePath, validResponse({
    verdict: "PASS",
    runId: result.runId,
    marker: result.manifest.artifact_marker
  }), "utf8");

  const decision = await recordResponse({ cwd, runId: result.runId, responseFile: responsePath });

  assert.equal(decision.verdict, "PASS");
  assert.equal(decision.marker_confirmed, true);
  assert.deepEqual(decision.invalid_reasons, []);
});

test("record-response marks missing artifact confirmation as REVIEW_INVALID", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nShip a small feature.\n", "utf8");
  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "invalid-case",
    planFile: "PLAN.md",
    includes: [],
    allowFiles: []
  });

  const responsePath = path.join(cwd, "response-invalid.md");
  await fs.writeFile(responsePath, validResponse({
    verdict: "PASS",
    runId: result.runId,
    marker: "wrong-marker"
  }).replace("markers_match: yes", "markers_match: no"), "utf8");

  const decision = await recordResponse({ cwd, runId: result.runId, responseFile: responsePath });

  assert.equal(decision.verdict, "REVIEW_INVALID");
  assert.equal(decision.marker_confirmed, false);
  assert.equal(decision.invalid_reasons.includes("artifact_markers_not_confirmed"), true);
});

test("record-response requires both artifact marker fields", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nShip a small feature.\n", "utf8");
  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "missing-marker-case",
    planFile: "PLAN.md",
    includes: [],
    allowFiles: []
  });

  for (const [name, response, reason] of [
    ["missing-manifest", validResponse({ verdict: "PASS", runId: result.runId, marker: result.manifest.artifact_marker }).replace(`- manifest_marker: ${result.manifest.artifact_marker}\n`, ""), "artifact_check_missing_manifest_marker"],
    ["missing-bundle", validResponse({ verdict: "PASS", runId: result.runId, marker: result.manifest.artifact_marker }).replace(`- bundle_marker: ${result.manifest.artifact_marker}\n`, ""), "artifact_check_missing_bundle_marker"],
    ["missing-both", validResponse({ verdict: "PASS", runId: result.runId, marker: result.manifest.artifact_marker }).replace(`- manifest_marker: ${result.manifest.artifact_marker}\n`, "").replace(`- bundle_marker: ${result.manifest.artifact_marker}\n`, ""), "artifact_check_missing_manifest_marker"]
  ]) {
    const responsePath = path.join(cwd, `${name}.md`);
    await fs.writeFile(responsePath, response, "utf8");
    const decision = await recordResponse({ cwd, runId: result.runId, responseFile: responsePath });
    assert.equal(decision.verdict, "REVIEW_INVALID");
    assert.equal(decision.invalid_reasons.includes(reason), true);
  }
});

test("record-response requires exact artifact version fields", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nShip a small feature.\n", "utf8");
  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "missing-version-case",
    planFile: "PLAN.md",
    includes: [],
    allowFiles: []
  });

  const baseResponse = validResponse({
    verdict: "PASS",
    runId: result.runId,
    marker: result.manifest.artifact_marker,
    manifestVersion: result.manifest.schema_version,
    bundleVersion: result.manifest.artifact_version
  });

  for (const [name, response, reason] of [
    ["missing-manifest-version", baseResponse.replace(`- manifest_version: ${result.manifest.schema_version}\n`, ""), "artifact_check_missing_manifest_version"],
    ["missing-bundle-version", baseResponse.replace(`- bundle_version: ${result.manifest.artifact_version}\n`, ""), "artifact_check_missing_bundle_version"],
    ["wrong-manifest-version", baseResponse.replace(`- manifest_version: ${result.manifest.schema_version}`, "- manifest_version: pro-review-manifest/v999"), "manifest_version_mismatch"],
    ["wrong-bundle-version", baseResponse.replace(`- bundle_version: ${result.manifest.artifact_version}`, "- bundle_version: v999"), "bundle_version_mismatch"]
  ]) {
    const responsePath = path.join(cwd, `${name}.md`);
    await fs.writeFile(responsePath, response, "utf8");
    const decision = await recordResponse({ cwd, runId: result.runId, responseFile: responsePath });
    assert.equal(decision.verdict, "REVIEW_INVALID");
    assert.equal(decision.invalid_reasons.includes(reason), true);
  }
});

test("record-response preserves PASS_WITH_NOTES verdict", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nShip a small feature.\n", "utf8");
  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "notes-case",
    planFile: "PLAN.md",
    includes: [],
    allowFiles: []
  });

  const responsePath = path.join(cwd, "response-notes.md");
  await fs.writeFile(responsePath, validResponse({
    verdict: "PASS_WITH_NOTES",
    runId: result.runId,
    marker: result.manifest.artifact_marker
  }), "utf8");

  const decision = await recordResponse({ cwd, runId: result.runId, responseFile: responsePath });

  assert.equal(decision.verdict, "PASS_WITH_NOTES");
  assert.equal(decision.raw_verdict, "PASS_WITH_NOTES");
});

test("record-response escalates risky PASS_WITH_NOTES concerns for disposition", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nShip a billing feature.\n", "utf8");
  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "risk-notes-case",
    planFile: "PLAN.md",
    includes: [],
    allowFiles: []
  });

  const responsePath = path.join(cwd, "response-risk-notes.md");
  const response = validResponse({
    verdict: "PASS_WITH_NOTES",
    runId: result.runId,
    marker: result.manifest.artifact_marker
  }).replace(
    "# Non-Blocking Concerns\n- none",
    "# Non-Blocking Concerns\n- Billing idempotency is mentioned, but the retry reconciliation path should be clarified before implementation."
  );
  await fs.writeFile(responsePath, response, "utf8");

  const decision = await recordResponse({ cwd, runId: result.runId, responseFile: responsePath });

  assert.equal(decision.raw_verdict, "PASS_WITH_NOTES");
  assert.equal(decision.verdict, "NEEDS_CONTEXT");
  assert.deepEqual(decision.policy_overrides, ["risk_notes_require_disposition"]);
  assert.equal(decision.risk_notes.length, 1);
});

test("record-response blocks inconsistent PASS responses that list blockers", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nShip a small feature.\n", "utf8");
  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "blocker-override",
    planFile: "PLAN.md",
    includes: [],
    allowFiles: []
  });

  const responsePath = path.join(cwd, "response-blocker-override.md");
  const response = validResponse({
    verdict: "PASS",
    runId: result.runId,
    marker: result.manifest.artifact_marker
  }).replace("# Blockers\n- none", "# Blockers\n- [high] src/app.js Unsafe behavior must be fixed.");
  await fs.writeFile(responsePath, response, "utf8");

  const decision = await recordResponse({ cwd, runId: result.runId, responseFile: responsePath });

  assert.equal(decision.raw_verdict, "PASS");
  assert.equal(decision.verdict, "BLOCKED");
  assert.deepEqual(decision.policy_overrides, ["blockers_present"]);
});

test("record-response tolerates exact plain heading lines copied from ChatGPT", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nShip a small feature.\n", "utf8");
  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "plain-heading",
    planFile: "PLAN.md",
    includes: [],
    allowFiles: []
  });

  const responsePath = path.join(cwd, "plain-response.md");
  await fs.writeFile(responsePath, plainHeadingResponse({
    verdict: "BLOCKED",
    runId: result.runId,
    marker: result.manifest.artifact_marker
  }), "utf8");

  const decision = await recordResponse({ cwd, runId: result.runId, responseFile: responsePath });

  assert.equal(decision.verdict, "BLOCKED");
  assert.equal(decision.blocker_count, 1);
  assert.deepEqual(decision.missing_sections, []);
});

test("prepare writes final artifact hashes that match written bytes", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nShip a small feature.\n", "utf8");
  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "hash-case",
    planFile: "PLAN.md",
    includes: [],
    allowFiles: []
  });

  const manifest = await readJson(path.join(result.runDir, "manifest.json"));
  const artifactHashes = await readJson(path.join(result.runDir, "artifact_hashes.json"));
  const reviewManifest = await fs.readFile(path.join(result.runDir, "review_manifest.md"), "utf8");
  const reviewBundle = await fs.readFile(path.join(result.runDir, "review_bundle.md"), "utf8");
  const prompt = await fs.readFile(path.join(result.runDir, "prompt.md"), "utf8");

  assert.equal(manifest.content_hashes.review_manifest_sha256, sha256(reviewManifest));
  assert.equal(manifest.content_hashes.review_bundle_sha256, sha256(reviewBundle));
  assert.equal(manifest.content_hashes.prompt_sha256, sha256(prompt));
  assert.deepEqual(artifactHashes.hashes, manifest.content_hashes);
});

test("MCP tools expose prepared review artifacts without arbitrary repository file access", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nReview the MCP transport.\n", "utf8");
  await fs.writeFile(path.join(cwd, "outside-secret.txt"), "secret-value-that-must-not-be-readable-through-mcp\n", "utf8");
  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "mcp-transport",
    planFile: "PLAN.md",
    includes: [],
    allowFiles: []
  });

  const runs = await callReviewMcpTool({
    cwd,
    name: "list_review_runs",
    arguments: { limit: 5 }
  });
  assert.equal(runs.structuredContent.count, 1);
  assert.equal(runs.structuredContent.runs[0].run_id, result.runId);
  assert.equal(runs.structuredContent.artifact_contract.repository_file_access, false);

  const artifact = await callReviewMcpTool({
    cwd,
    name: "get_review_artifact",
    arguments: { run_id: result.runId, artifact: "review_bundle" }
  });
  assert.match(artifact.structuredContent.content, /Review the MCP transport/);
  assert.equal(artifact.structuredContent.content.includes("secret-value-that-must-not-be-readable-through-mcp"), false);

  const search = await callReviewMcpTool({
    cwd,
    name: "search_review_bundle",
    arguments: { run_id: result.runId, query: "MCP transport", context_lines: 1 }
  });
  assert.equal(search.structuredContent.match_count >= 1, true);

  const compatibilitySearch = await callReviewMcpTool({
    cwd,
    name: "search",
    arguments: { query: result.runId }
  });
  assert.equal(compatibilitySearch.structuredContent.results.length >= 2, true);
  assert.equal(compatibilitySearch.structuredContent.results.some((item) => item.id === `${result.runId}:review_bundle`), true);

  const compatibilityFetch = await callReviewMcpTool({
    cwd,
    name: "fetch",
    arguments: { id: `${result.runId}:review_bundle` }
  });
  assert.match(compatibilityFetch.structuredContent.text, /Review the MCP transport/);
  assert.equal(compatibilityFetch.structuredContent.metadata.artifact, "review_bundle");

  await assert.rejects(
    callReviewMcpTool({
      cwd,
      name: "get_review_artifact",
      arguments: { run_id: "../outside", artifact: "review_bundle" }
    }),
    /Invalid run_id/
  );
  await assert.rejects(
    callReviewMcpTool({
      cwd,
      name: "get_review_artifact",
      arguments: { run_id: result.runId, artifact: "outside-secret.txt" }
    }),
    /Unsupported artifact/
  );

  const prompt = await renderMcpReviewPrompt({ cwd, runId: result.runId });
  assert.match(prompt, new RegExp(result.runId));
  assert.match(prompt, new RegExp(result.manifest.artifact_marker));
  assert.match(prompt, /get_review_artifact/);
});

test("MCP HTTP endpoint lists tools and requires bearer token when configured", async () => {
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, "PLAN.md"), "# Plan\n\nServe artifacts through MCP.\n", "utf8");
  const result = await prepareReview({
    cwd,
    mode: "plan",
    feature: "mcp-http",
    planFile: "PLAN.md",
    includes: [],
    allowFiles: []
  });
  const output = [];
  const serverResult = await startReviewMcpServer({
    cwd,
    host: "127.0.0.1",
    port: 0,
    token: "test-token",
    stdout: { write: (chunk) => output.push(chunk) }
  });

  try {
    const unauthorized = await postJson(serverResult.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers["www-authenticate"], "Bearer realm=\"pro-review-mcp\"");

    const initialized = await postJson(serverResult.url, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {}
    }, "test-token");
    assert.equal(initialized.status, 200);
    assert.equal(initialized.body.result.serverInfo.name, "pro-review-mcp");
    assert.match(initialized.body.result.instructions, /prepared Pro Review artifacts only/);
    assert.equal(initialized.body.result.capabilities.tools.listChanged, false);

    const tools = await postJson(serverResult.url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {}
    }, "test-token");
    const reviewArtifactTool = tools.body.result.tools.find((tool) => tool.name === "get_review_artifact");
    assert.equal(Boolean(reviewArtifactTool), true);
    assert.equal(reviewArtifactTool.annotations.readOnlyHint, true);
    assert.equal(reviewArtifactTool.outputSchema.type, "object");
    const searchTool = tools.body.result.tools.find((tool) => tool.name === "search");
    assert.equal(searchTool.outputSchema.required.includes("results"), true);

    const artifact = await postJson(serverResult.url, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "get_review_artifact",
        arguments: { run_id: result.runId, artifact: "review_manifest" }
      }
    }, "test-token");
    assert.match(artifact.body.result.structuredContent.content, new RegExp(result.runId));

    const initializedNotification = await postJson(serverResult.url, {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    }, "test-token");
    assert.equal(initializedNotification.status, 202);
    assert.equal(initializedNotification.body, null);
    assert.equal(output.join("").includes(serverResult.url), true);
  } finally {
    await new Promise((resolve, reject) => {
      serverResult.server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("prepare applies include rules to non-explicit git candidates and denies sensitive paths", async () => {
  const cwd = await tempDir();
  await execFileAsync("git", ["init"], { cwd });
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.mkdir(path.join(cwd, "notes"), { recursive: true });
  await fs.mkdir(path.join(cwd, "exports"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "allowed.mjs"), "export const ok = true;\n", "utf8");
  await fs.writeFile(path.join(cwd, "notes", "outside.txt"), "not part of include rules\n", "utf8");
  await fs.writeFile(path.join(cwd, "exports", "customer-list.csv"), "name,email\nJane,jane@example.com\n", "utf8");

  const result = await prepareReview({
    cwd,
    mode: "implementation",
    feature: "selection-case",
    includes: ["exports/customer-list.csv"],
    allowFiles: []
  });

  assert.equal(result.includedFiles.some((file) => file.path === "src/allowed.mjs"), true);
  assert.equal(result.includedFiles.some((file) => file.path === "notes/outside.txt"), false);
  assert.equal(result.excludedFiles.some((file) => file.path === "notes/outside.txt" && file.reason === "not_in_include_rules"), true);
  assert.equal(result.excludedFiles.some((file) => file.path === "[sensitive-path-redacted]" && file.reason === "denylisted" && file.sensitive_path === true), true);
});

test("prepare includes committed feature branch changes in a clean git worktree", async () => {
  const cwd = await tempDir();
  await execFileAsync("git", ["init", "-b", "main"], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Pro Review Test"], { cwd });
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "base.mjs"), "export const base = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/base.mjs"], { cwd });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd });
  await execFileAsync("git", ["checkout", "-b", "feature/review-context"], { cwd });
  await fs.writeFile(path.join(cwd, "src", "feature.mjs"), "export const feature = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/feature.mjs"], { cwd });
  await execFileAsync("git", ["commit", "-m", "feature change"], { cwd });

  const status = (await execFileAsync("git", ["status", "--porcelain=v1"], { cwd })).stdout;
  assert.equal(status, "");

  const result = await prepareReview({
    cwd,
    mode: "implementation",
    feature: "clean-feature-branch",
    includes: [],
    allowFiles: []
  });

  assert.equal(result.includedFiles.some((file) => file.path === "src/feature.mjs" && file.reason === "committed-change"), true);
  assert.equal(result.manifest.git.committed_included.includes("src/feature.mjs"), true);
});

test("prepare auto-detects master when local main is absent", async () => {
  const cwd = await tempDir();
  await initGitRepo(cwd, "master");
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "base.mjs"), "export const base = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/base.mjs"], { cwd });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd });
  await execFileAsync("git", ["checkout", "-b", "feature/master-base"], { cwd });
  await fs.writeFile(path.join(cwd, "src", "feature.mjs"), "export const feature = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/feature.mjs"], { cwd });
  await execFileAsync("git", ["commit", "-m", "feature change"], { cwd });

  const result = await prepareReview({
    cwd,
    mode: "implementation",
    feature: "master-base",
    includes: [],
    allowFiles: []
  });

  assert.equal(result.manifest.git.base_ref, "master");
  assert.equal(result.includedFiles.some((file) => file.path === "src/feature.mjs" && file.reason === "committed-change"), true);
});

test("prepare honors explicit baseRef for non-default trunk branches", async () => {
  const cwd = await tempDir();
  await initGitRepo(cwd, "develop");
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "base.mjs"), "export const base = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/base.mjs"], { cwd });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd });
  await execFileAsync("git", ["checkout", "-b", "feature/develop-base"], { cwd });
  await fs.writeFile(path.join(cwd, "src", "feature.mjs"), "export const feature = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/feature.mjs"], { cwd });
  await execFileAsync("git", ["commit", "-m", "feature change"], { cwd });

  const result = await prepareReview({
    cwd,
    mode: "implementation",
    feature: "develop-base",
    includes: [],
    allowFiles: [],
    baseRef: "develop"
  });

  assert.equal(result.manifest.git.base_ref, "develop");
  assert.equal(result.includedFiles.some((file) => file.path === "src/feature.mjs" && file.reason === "committed-change"), true);
});

test("prepare prefers origin HEAD over fallback local main", async () => {
  const cwd = await tempDir();
  await initGitRepo(cwd, "main");
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "root.mjs"), "export const root = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/root.mjs"], { cwd });
  await execFileAsync("git", ["commit", "-m", "root"], { cwd });
  await execFileAsync("git", ["checkout", "-b", "develop"], { cwd });
  await fs.writeFile(path.join(cwd, "src", "develop-base.mjs"), "export const developBase = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/develop-base.mjs"], { cwd });
  await execFileAsync("git", ["commit", "-m", "develop base"], { cwd });
  await execFileAsync("git", ["update-ref", "refs/remotes/origin/develop", "HEAD"], { cwd });
  await execFileAsync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"], { cwd });
  await execFileAsync("git", ["checkout", "-b", "feature/origin-default"], { cwd });
  await fs.writeFile(path.join(cwd, "src", "feature.mjs"), "export const feature = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/feature.mjs"], { cwd });
  await execFileAsync("git", ["commit", "-m", "feature change"], { cwd });

  const result = await prepareReview({
    cwd,
    mode: "implementation",
    feature: "origin-default",
    includes: [],
    allowFiles: []
  });

  assert.equal(result.manifest.git.base_ref, "origin/develop");
  assert.equal(result.includedFiles.some((file) => file.path === "src/feature.mjs" && file.reason === "committed-change"), true);
  assert.equal(result.includedFiles.some((file) => file.path === "src/develop-base.mjs"), false);
});

test("CLI prepare passes explicit base-ref through to git detection", async () => {
  const cwd = await tempDir();
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  await initGitRepo(cwd, "develop");
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "base.mjs"), "export const base = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/base.mjs"], { cwd });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd });
  await execFileAsync("git", ["checkout", "-b", "feature/cli-base"], { cwd });
  await fs.writeFile(path.join(cwd, "src", "feature.mjs"), "export const feature = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/feature.mjs"], { cwd });
  await execFileAsync("git", ["commit", "-m", "feature change"], { cwd });

  const { stdout } = await execFileAsync(process.execPath, [
    path.join(repoRoot, "bin", "pro-review.mjs"),
    "prepare",
    "--mode",
    "implementation",
    "--feature",
    "cli-base-ref",
    "--base-ref",
    "develop"
  ], { cwd });
  const runId = stdout.match(/Prepared pro-review run: (\S+)/)?.[1];
  assert.ok(runId);
  const manifest = await readJson(path.join(cwd, ".pro-review", "runs", runId, "manifest.json"));

  assert.equal(manifest.git.base_ref, "develop");
  assert.equal(manifest.included_files.some((file) => file.path === "src/feature.mjs" && file.reason === "committed-change"), true);
});

test("prepare labels files that are committed and dirty in the worktree", async () => {
  const cwd = await tempDir();
  await initGitRepo(cwd, "main");
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "base.mjs"), "export const base = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/base.mjs"], { cwd });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd });
  await execFileAsync("git", ["checkout", "-b", "feature/dirty-committed"], { cwd });
  await fs.writeFile(path.join(cwd, "src", "feature.mjs"), "export const committed = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/feature.mjs"], { cwd });
  await execFileAsync("git", ["commit", "-m", "feature change"], { cwd });
  await fs.writeFile(path.join(cwd, "src", "feature.mjs"), "export const committed = true;\nexport const dirty = true;\n", "utf8");

  const result = await prepareReview({
    cwd,
    mode: "implementation",
    feature: "dirty-committed",
    includes: [],
    allowFiles: []
  });

  assert.equal(result.includedFiles.some((file) => file.path === "src/feature.mjs" && file.reason === "committed-change+working-tree-change"), true);
});

test("prepare includes committed deletions as review evidence", async () => {
  const cwd = await tempDir();
  await initGitRepo(cwd, "main");
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.writeFile(path.join(cwd, "src", "removed.mjs"), "export const removed = true;\n", "utf8");
  await execFileAsync("git", ["add", "src/removed.mjs"], { cwd });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd });
  await execFileAsync("git", ["checkout", "-b", "feature/delete-file"], { cwd });
  await execFileAsync("git", ["rm", "src/removed.mjs"], { cwd });
  await execFileAsync("git", ["commit", "-m", "delete file"], { cwd });

  const result = await prepareReview({
    cwd,
    mode: "implementation",
    feature: "delete-file",
    includes: [],
    allowFiles: []
  });
  const bundle = await fs.readFile(path.join(result.runDir, "review_bundle.md"), "utf8");
  const deleted = result.includedFiles.find((file) => file.path === "src/removed.mjs");
  const syntheticContent = "[File deleted in committed diff. No current file contents are available.]\n";

  assert.equal(deleted.reason, "committed-deletion");
  assert.equal(deleted.size_bytes, 0);
  assert.equal(deleted.sha256, sha256(syntheticContent));
  assert.equal(result.manifest.git.committed_deleted_included.includes("src/removed.mjs"), true);
  assert.match(bundle, /File deleted in committed diff/);
});

test("package bin entrypoint prints help", async () => {
  const cwd = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const { stdout } = await execFileAsync(process.execPath, [path.join(cwd, "bin", "pro-review.mjs"), "help"], { cwd });

  assert.match(stdout, /pro-review/);
  assert.match(stdout, /start <intent>/);
  assert.match(stdout, /audit/);
  assert.match(stdout, /pro-review publish/);
  assert.match(stdout, /pro-review mcp/);
  assert.match(stdout, /publish defaults to the latest prepared run/);
  assert.match(stdout, /record-response/);
  assert.match(stdout, /--base-ref/);
  assert.match(stdout, /Codex in-app browser/);
});

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "pro-review-test-"));
}

async function initGitRepo(cwd, branch) {
  await execFileAsync("git", ["init", "-b", branch], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Pro Review Test"], { cwd });
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

function textResponse(body, init = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain" },
    ...init
  });
}

function postJson(url, body, token = "") {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const requestBody = JSON.stringify(body);
    const req = http.request({
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      headers: {
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(requestBody),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: text ? JSON.parse(text) : null
        });
      });
    });
    req.on("error", reject);
    req.end(requestBody);
  });
}

function validResponse({ verdict, runId, marker }) {
  return `# Verdict
${verdict}

# Artifact Check
- run_id: ${runId}
- manifest_version: pro-review-manifest/v0
- bundle_version: v0
- manifest_marker: ${marker}
- bundle_marker: ${marker}
- markers_match: yes
- artifact_versions_match: yes

# Context Completeness
- none

# Baseline Critique Disposition
- none

# Failure-Mode Coverage
- not applicable: covered; this fixture has no material failure modes; no missing test.

# Blockers
- none

# Requested Context
- none

# Non-Blocking Concerns
- none

# Missing Tests
- none

# Questions
- none

# Proceed Decision
Proceed according to the verdict.

# Confidence
High, because the artifact check was explicit.
`;
}

function plainHeadingResponse({ verdict, runId, marker }) {
  return `Verdict

${verdict}

Artifact Check
run_id: ${runId}
manifest_version: pro-review-manifest/v0
bundle_version: v0
manifest_marker: ${marker}
bundle_marker: ${marker}
markers_match: yes
artifact_versions_match: yes

Context Completeness
none

Baseline Critique Disposition
none

Failure-Mode Coverage
not applicable: covered; fixture only.

Blockers
[high] src/app.js Fix the issue.

Requested Context
none

Non-Blocking Concerns
none

Missing Tests
none

Questions
none

Proceed Decision
Do not proceed.

Confidence
High.
`;
}
