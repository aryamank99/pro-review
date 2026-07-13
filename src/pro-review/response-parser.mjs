import path from "node:path";
import { REQUIRED_RESPONSE_HEADINGS, VALID_VERDICTS } from "./constants.mjs";
import { readJson, writeJson, writeText } from "./fs-utils.mjs";
import { copyResponse } from "./artifacts.mjs";

export function parseReviewResponse(text, manifest) {
  const sections = parseResponseSections(text);
  const missingSections = REQUIRED_RESPONSE_HEADINGS.filter((heading) => !sections.has(normalizeHeading(heading)));
  const rawVerdict = extractVerdict(sections.get("verdict") || "");
  const artifact = parseArtifactCheck(sections.get("artifact-check") || "");

  let verdict = rawVerdict || "REVIEW_INVALID";
  const invalidReasons = [];

  if (!rawVerdict) invalidReasons.push("missing_or_invalid_verdict");
  if (missingSections.length > 0) invalidReasons.push(`missing_sections:${missingSections.join(",")}`);

  if (!artifact.run_id) {
    invalidReasons.push("artifact_check_missing_run_id");
  } else if (artifact.run_id !== manifest.run_id) {
    invalidReasons.push("artifact_check_wrong_run_id");
  }

  if (!artifact.markers_match_confirmed) invalidReasons.push("artifact_markers_not_confirmed");
  if (!artifact.artifact_versions_match_confirmed) invalidReasons.push("artifact_versions_not_confirmed");
  if (!artifact.manifest_version) {
    invalidReasons.push("artifact_check_missing_manifest_version");
  } else if (artifact.manifest_version !== manifest.schema_version) {
    invalidReasons.push("manifest_version_mismatch");
  }
  if (!artifact.bundle_version) {
    invalidReasons.push("artifact_check_missing_bundle_version");
  } else if (artifact.bundle_version !== manifest.artifact_version) {
    invalidReasons.push("bundle_version_mismatch");
  }
  if (!artifact.manifest_marker) {
    invalidReasons.push("artifact_check_missing_manifest_marker");
  } else if (artifact.manifest_marker !== manifest.artifact_marker) {
    invalidReasons.push("manifest_marker_mismatch");
  }
  if (!artifact.bundle_marker) {
    invalidReasons.push("artifact_check_missing_bundle_marker");
  } else if (artifact.bundle_marker !== manifest.artifact_marker) {
    invalidReasons.push("bundle_marker_mismatch");
  }

  const blockers = extractSectionItems(sections.get("blockers") || "");
  const requestedContext = extractSectionItems(sections.get("requested-context") || "");
  const questions = extractSectionItems(sections.get("questions") || "");
  const nonBlockingConcerns = extractSectionItems(sections.get("non-blocking-concerns") || "");
  const contextCompleteness = extractSectionItems(sections.get("context-completeness") || "");
  const failureModeCoverage = extractSectionItems(sections.get("failure-mode-coverage") || "");
  const meaningfulBlockers = meaningfulItems(blockers);
  const meaningfulRequestedContext = meaningfulItems(requestedContext);
  const meaningfulContextCompleteness = meaningfulItems(contextCompleteness);
  const meaningfulFailureModeCoverage = meaningfulItems(failureModeCoverage);
  const riskNotes = riskyNonBlockingItems(nonBlockingConcerns);
  const contextGaps = contextGapItems(meaningfulContextCompleteness);
  const policyOverrides = [];

  if (invalidReasons.length > 0) {
    verdict = "REVIEW_INVALID";
  } else if (meaningfulBlockers.length > 0 && verdict !== "BLOCKED") {
    verdict = "BLOCKED";
    policyOverrides.push("blockers_present");
  } else if (meaningfulRequestedContext.length > 0 && !["NEEDS_CONTEXT", "BLOCKED", "NEEDS_HUMAN"].includes(verdict)) {
    verdict = "NEEDS_CONTEXT";
    policyOverrides.push("requested_context_present");
  } else if (contextGaps.length > 0 && !["NEEDS_CONTEXT", "BLOCKED", "NEEDS_HUMAN"].includes(verdict)) {
    verdict = "NEEDS_CONTEXT";
    policyOverrides.push("context_gaps_present");
  } else if (riskNotes.length > 0 && ["PASS", "PASS_WITH_NOTES"].includes(verdict)) {
    verdict = "NEEDS_CONTEXT";
    policyOverrides.push("risk_notes_require_disposition");
  }

  return {
    verdict,
    raw_verdict: rawVerdict,
    run_id: manifest.run_id,
    marker_confirmed: invalidReasons.length === 0,
    blocker_count: meaningfulBlockers.length,
    requested_context: meaningfulRequestedContext,
    context_gaps: contextGaps,
    risk_notes: riskNotes,
    failure_mode_coverage_count: meaningfulFailureModeCoverage.length,
    human_escalation_questions: verdict === "NEEDS_HUMAN" ? meaningfulItems(questions) : [],
    missing_sections: missingSections,
    invalid_reasons: invalidReasons,
    policy_overrides: policyOverrides,
    artifact_check: artifact
  };
}

export async function recordResponse({ cwd, runId, responseFile }) {
  const runDir = path.join(cwd, ".pro-review", "runs", runId);
  const manifest = await readJson(path.join(runDir, "manifest.json"));
  const responseText = await import("node:fs/promises").then((fs) => fs.readFile(responseFile, "utf8"));
  const responsePath = path.join(runDir, "response.md");
  await copyResponse(responseFile, responsePath);

  const decision = parseReviewResponse(responseText, manifest);
  decision.response_path = responsePath;
  decision.decision_path = path.join(runDir, "decision.json");
  await writeJson(decision.decision_path, decision);
  await writeText(path.join(runDir, "decision-summary.md"), renderDecisionSummary(decision));
  return decision;
}

function parseResponseSections(text) {
  const allowedHeadings = new Set(REQUIRED_RESPONSE_HEADINGS.map(normalizeHeading));
  const sections = new Map();
  let currentHeading = null;
  let currentLines = [];

  const flush = () => {
    if (currentHeading) {
      sections.set(currentHeading, currentLines.join("\n").trim());
    }
  };

  for (const line of text.split(/\r?\n/)) {
    const markdownHeading = line.match(/^#\s+(.+?)\s*$/);
    const candidate = normalizeHeading(markdownHeading ? markdownHeading[1] : line);
    if (allowedHeadings.has(candidate)) {
      flush();
      currentHeading = candidate;
      currentLines = [];
      continue;
    }
    if (currentHeading) {
      currentLines.push(line);
    }
  }

  flush();
  return sections;
}

function normalizeHeading(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function extractVerdict(value) {
  const upper = value.toUpperCase();
  const verdicts = [...VALID_VERDICTS].sort((a, b) => b.length - a.length);
  for (const verdict of verdicts) {
    const pattern = new RegExp(`(^|[^A-Z_])${verdict.replace(/_/g, "_")}([^A-Z_]|$)`);
    if (pattern.test(upper)) return verdict;
  }
  return null;
}

function parseArtifactCheck(value) {
  const fields = {};
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\s*-?\s*([A-Za-z_ -]+):\s*(.+?)\s*$/);
    if (!match) continue;
    const key = normalizeHeading(match[1]).replace(/-/g, "_");
    fields[key] = match[2].trim();
  }

  return {
    run_id: cleanField(fields.run_id),
    manifest_marker: cleanField(fields.manifest_marker),
    bundle_marker: cleanField(fields.bundle_marker),
    manifest_version: cleanField(fields.manifest_version),
    bundle_version: cleanField(fields.bundle_version),
    markers_match: cleanField(fields.markers_match),
    artifact_versions_match: cleanField(fields.artifact_versions_match),
    markers_match_confirmed: /^yes\b/i.test(fields.markers_match || ""),
    artifact_versions_match_confirmed: /^yes\b/i.test(fields.artifact_versions_match || "")
  };
}

function cleanField(value) {
  if (!value) return null;
  return value.replace(/[`*]/g, "").trim();
}

function extractSectionItems(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

function meaningfulItems(items) {
  return items.filter((item) => item && !/^(none|n\/a|not applicable)\.?$/i.test(item));
}

function riskyNonBlockingItems(items) {
  const riskPattern = /\b(auth|authorization|authz|billing|money|payment|minutes?|ledger|idempotenc|retry|timeout|race|concurren|duplicate|double|webhook|external provider|side effect|partial failure|source[- ]of[- ]truth|data integrity|migration|rollback|deploy|security|privacy|secret|tenant|reconciliation|repair|state regression|stale|late event|missing test|coverage gap)\b/i;
  return meaningfulItems(items).filter((item) => riskPattern.test(item));
}

function contextGapItems(items) {
  const gapPattern = /\b(missing|absent|truncated|excluded|not included|need(s|ed)? context|cannot verify|insufficient evidence|requested context)\b/i;
  return meaningfulItems(items).filter((item) => gapPattern.test(item));
}

function renderDecisionSummary(decision) {
  return [
    "# Review Decision",
    "",
    `verdict: ${decision.verdict}`,
    `run_id: ${decision.run_id}`,
    `marker_confirmed: ${decision.marker_confirmed}`,
    `blocker_count: ${decision.blocker_count}`,
    `requested_context_count: ${decision.requested_context.length}`,
    `context_gap_count: ${decision.context_gaps.length}`,
    `risk_note_count: ${decision.risk_notes.length}`,
    `failure_mode_coverage_count: ${decision.failure_mode_coverage_count}`,
    `invalid_reasons: ${decision.invalid_reasons.length ? decision.invalid_reasons.join(", ") : "none"}`,
    ""
  ].join("\n");
}
