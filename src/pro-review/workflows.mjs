import path from "node:path";
import { slugify } from "./fs-utils.mjs";

export const REVIEW_MODES = new Set([
  "plan",
  "implementation",
  "signoff",
  "audit",
  "debug",
  "migration",
  "refactor"
]);

export const REVIEW_LENSES = {
  architecture: "Review module boundaries, locality, interfaces, testability, domain vocabulary, ADR consistency, and whether abstractions earn their keep.",
  "code-structure": "Review orchestration versus reusable mechanics, duplicated operational blocks, misplaced domain policy, leaky services, inconsistent service APIs, and premature abstraction.",
  security: "Review authn/authz, tenant boundaries, secrets, webhook trust, injection, prompt-injection boundaries, and sensitive logging.",
  testing: "Review coverage against risk, regression cases, behavior assertions, testability through stable interfaces, and false confidence from shallow tests.",
  reliability: "Review retries, idempotency, partial failure, timeouts, concurrency, recovery, stuck states, and operational safety.",
  "data-integrity": "Review lifecycle states, migrations, backfills, reconciliation, billing correctness, duplicate/late events, auditability, and verification queries.",
  observability: "Review logs, metrics, correlation IDs, smoke checks, operational debugging support, and post-deploy monitoring signals."
};

const FEATURE_LENSES = ["architecture", "code-structure", "security", "testing", "reliability", "data-integrity", "observability"];
const AUDIT_LENSES = ["architecture", "code-structure", "security", "testing", "reliability", "data-integrity", "observability"];
const DEBUG_LENSES = ["reliability", "data-integrity", "observability", "testing", "security"];
const MIGRATION_LENSES = ["data-integrity", "reliability", "security", "testing", "observability"];
const REFACTOR_LENSES = ["architecture", "code-structure", "testing", "reliability"];

export const PLAYBOOKS = {
  feature: {
    name: "feature",
    intent: "Build, add, implement, or create new behavior.",
    firstStage: "plan-review",
    firstMode: "plan",
    defaultLenses: FEATURE_LENSES,
    stages: [
      { name: "planning-grill", mode: null, description: "Clarify domain terms, constraints, edge cases, and human decisions before Pro review." },
      { name: "plan-review", mode: "plan", description: "Review the plan before implementation." },
      { name: "implementation", mode: null, description: "Implement the accepted plan." },
      { name: "implementation-review", mode: "implementation", description: "Review changed files and tests." },
      { name: "signoff", mode: "signoff", description: "Final release-readiness review." }
    ],
    goalModePolicy: "after-plan-pass"
  },
  audit: {
    name: "audit",
    intent: "Review an existing implementation, subsystem, operational flow, or current behavior.",
    firstStage: "audit-review",
    firstMode: "audit",
    defaultLenses: AUDIT_LENSES,
    stages: [
      { name: "scope", mode: null, description: "Identify boundaries, entrypoints, docs, tests, and known risks." },
      { name: "audit-review", mode: "audit", description: "Review existing code through the default audit lenses." },
      { name: "recommendations", mode: null, description: "Order findings by severity, effort, sequencing, and risk." }
    ],
    goalModePolicy: "remediation-only"
  },
  debug: {
    name: "debug",
    intent: "Investigate a failure, incident, confusing behavior, or regression.",
    firstStage: "root-cause-review",
    firstMode: "debug",
    defaultLenses: DEBUG_LENSES,
    stages: [
      { name: "evidence", mode: null, description: "Gather symptoms, logs, errors, configs, code, and reproduction steps." },
      { name: "root-cause-review", mode: "debug", description: "Review likely root cause and missing evidence." },
      { name: "fix-review", mode: "implementation", description: "Review the proposed fix." }
    ],
    goalModePolicy: "multi-step"
  },
  migration: {
    name: "migration",
    intent: "Plan and review schema changes, backfills, data repair, billing corrections, or operational scripts.",
    firstStage: "migration-plan",
    firstMode: "migration",
    defaultLenses: MIGRATION_LENSES,
    stages: [
      { name: "migration-plan", mode: "migration", description: "Review data model, idempotency, dry-run, rollback, batching, and verification." },
      { name: "migration-implementation", mode: "implementation", description: "Review implementation safety, concurrency, resumability, and observability." },
      { name: "migration-signoff", mode: "signoff", description: "Final production-readiness review." }
    ],
    goalModePolicy: "from-start"
  },
  refactor: {
    name: "refactor",
    intent: "Improve structure while preserving behavior.",
    firstStage: "architecture-review",
    firstMode: "refactor",
    defaultLenses: REFACTOR_LENSES,
    stages: [
      { name: "architecture-review", mode: "refactor", description: "Find shallow modules, duplication, poor locality, and weak interfaces." },
      { name: "refactor-plan", mode: "plan", description: "Review the behavior-preserving plan and test strategy." },
      { name: "implementation-review", mode: "implementation", description: "Verify behavior preservation and complexity reduction." }
    ],
    goalModePolicy: "broad-work"
  }
};

export function resolveWorkflow({ intent = "", playbook = null, workName = null, mode = null }) {
  const normalizedIntent = normalizeIntent(intent);
  const resolvedPlaybook = playbook ? requirePlaybook(playbook) : inferPlaybook(normalizedIntent, mode);
  const definition = PLAYBOOKS[resolvedPlaybook];
  const resolvedWorkName = workName || deriveWorkName(normalizedIntent, resolvedPlaybook);
  const workSlug = slugify(resolvedWorkName || resolvedPlaybook, "work");
  const stage = mode ? stageForMode(definition, mode) : definition.firstStage;
  const reviewMode = mode || definition.firstMode;

  return {
    playbook: definition.name,
    work_name: resolvedWorkName,
    work_slug: workSlug,
    stage,
    mode: reviewMode,
    lenses: [...definition.defaultLenses],
    goal_mode_policy: definition.goalModePolicy,
    playbook_intent: definition.intent,
    stages: definition.stages
  };
}

export function validateLenses(lenses) {
  const out = [];
  for (const lens of lenses || []) {
    if (!REVIEW_LENSES[lens]) throw new Error(`Unknown review lens "${lens}". Expected one of: ${Object.keys(REVIEW_LENSES).join(", ")}`);
    if (!out.includes(lens)) out.push(lens);
  }
  return out;
}

export function renderLensPrompt(lenses) {
  const active = validateLenses(lenses);
  if (active.length === 0) return "No additional review lenses were configured.";
  return active.map((lens) => `- ${lens}: ${REVIEW_LENSES[lens]}`).join("\n");
}

export function getPlaybook(name) {
  return PLAYBOOKS[requirePlaybook(name)];
}

export function allModesText() {
  return [...REVIEW_MODES].join("|");
}

function inferPlaybook(intent, mode) {
  if (mode === "audit") return "audit";
  if (mode === "debug") return "debug";
  if (mode === "migration") return "migration";
  if (mode === "refactor") return "refactor";

  if (/\b(debug|investigate|root cause|root-cause|failure|failing|incident|error|bug)\b/.test(intent)) return "debug";
  if (/\b(migrate|migration|backfill|schema|data repair|repair data|production data|billing correction)\b/.test(intent)) return "migration";
  if (/\b(refactor|simplify|clean up|cleanup|restructure|architecture cleanup|code structure)\b/.test(intent)) return "refactor";
  if (/\b(review|audit|inspect|assess|evaluate)\b/.test(intent)) return "audit";
  return "feature";
}

function deriveWorkName(intent, playbook) {
  const stripped = intent
    .replace(/^use\s+pro-review\s+to\s+/i, "")
    .replace(/^(build out|build|add|implement|create|ship|review|audit|inspect|assess|evaluate|debug|investigate|root cause|migrate|migration|backfill|refactor|simplify|clean up|cleanup)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped || playbook;
}

function normalizeIntent(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^use\s+pro-review\s+to\s+/, "");
}

function requirePlaybook(name) {
  const normalized = slugify(name);
  if (!PLAYBOOKS[normalized]) throw new Error(`Unknown playbook "${name}". Expected one of: ${Object.keys(PLAYBOOKS).join(", ")}`);
  return normalized;
}

function stageForMode(playbook, mode) {
  const stage = playbook.stages.find((item) => item.mode === mode);
  return stage?.name || mode;
}
