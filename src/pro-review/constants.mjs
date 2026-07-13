export const TOOL_VERSION = "0.1.0";
export const PROMPT_VERSION = "pro-review-prompt/v0";
export const MANIFEST_SCHEMA_VERSION = "pro-review-manifest/v0";
export const ARTIFACT_VERSION = "v0";

export const VALID_MODES = new Set(["plan", "implementation", "signoff", "audit", "debug", "migration", "refactor"]);

export const REQUIRED_RESPONSE_HEADINGS = [
  "Verdict",
  "Artifact Check",
  "Context Completeness",
  "Baseline Critique Disposition",
  "Failure-Mode Coverage",
  "Blockers",
  "Requested Context",
  "Non-Blocking Concerns",
  "Missing Tests",
  "Questions",
  "Proceed Decision",
  "Confidence"
];

export const VALID_VERDICTS = new Set([
  "PASS",
  "PASS_WITH_NOTES",
  "BLOCKED",
  "NEEDS_CONTEXT",
  "NEEDS_HUMAN",
  "REVIEW_INVALID"
]);

export const DEFAULT_CONFIG = {
  repoSlug: null,
  baseRef: null,
  backend: "google-drive-docs",
  auditMode: "metadata-only",
  drive: {
    rootFolderName: "pro-review",
    folderLayout: "{rootFolderName}/{repoSlug}/{workSlug}",
    oauthScope: "https://www.googleapis.com/auth/drive.file",
    oauthClientPath: ".pro-review/google-oauth-client.json",
    tokenPath: ".pro-review/google-drive-token.json"
  },
  chatgpt: {
    browserSurface: "codex-in-app-browser",
    projectUrl: null,
    newChatPolicy: "per-review-run",
    sameRunFollowups: true
  },
  context: {
    sizeBudgetBytes: 250000,
    perFileBudgetBytes: 60000,
    include: [
      "README.md",
      "docs/**/*.md",
      "src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      "tests/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      "test/**/*.{ts,tsx,js,jsx,mjs,cjs}",
      "bin/**/*.{js,mjs,cjs}",
      "package.json"
    ],
    exclude: [
      ".env",
      ".env.*",
      "**/.env",
      "**/.env.*",
      ".git/**",
      ".pro-review/runs/**",
      "node_modules/**",
      "dist/**",
      "build/**",
      ".next/**",
      "coverage/**"
    ]
  },
  gates: {
    plan: "block-on-blockers",
    implementation: "block-on-blockers",
    signoff: "block-on-blockers",
    audit: "block-on-blockers",
    debug: "block-on-blockers",
    migration: "block-on-blockers",
    refactor: "block-on-blockers"
  }
};

export const COMMON_CONTEXT_FILES = [
  "README.md",
  "AGENTS.md",
  "ENGINEERING_DESIGN.md",
  "package.json",
  "bin/pro-review.mjs",
  "tsconfig.json",
  "jsconfig.json"
];
