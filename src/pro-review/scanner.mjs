import path from "node:path";
import { matchesAnyPattern } from "./patterns.mjs";

const DANGEROUS_PATH_PATTERNS = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*secret*",
  "**/*credential*",
  "**/*token*",
  "**/*private-data*",
  "**/*customer-data*",
  "**/*customer*export*",
  "**/*customers*export*",
  "**/*pii*",
  "**/*prod-log*",
  "**/*production-log*",
  "**/customer_exports/**",
  "**/customer-exports/**",
  "**/*service-account*",
  "**/*service_account*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.sqlite",
  "**/*.sqlite3",
  "**/*.db",
  "**/*.dump",
  "**/*.log",
  "**/id_rsa",
  "**/id_dsa",
  "**/id_ed25519",
  "**/Cookies",
  "**/Login Data",
  "node_modules/**",
  ".git/**",
  ".pro-review/runs/**",
  "dist/**",
  "build/**",
  ".next/**",
  "coverage/**"
];

const ABSOLUTE_DENY_PATH_PATTERNS = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*"
];

const SECRET_PATTERNS = [
  { reason: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { reason: "openai-token-prefix", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { reason: "github-token-prefix", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/ },
  { reason: "slack-token-prefix", re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { reason: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { reason: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/ }
];

export function classifyPath(relativePath, configExcludes = [], allowFiles = new Set()) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (isAbsoluteDeniedPath(normalized)) {
    return {
      ok: false,
      reason: "forbidden_env_file",
      sensitive_path: true,
      path: sanitizedPath(normalized)
    };
  }

  const isAllowed = allowFiles.has(normalized);
  const sensitivePath = isSensitivePath(normalized);
  const denylisted = sensitivePath || matchesAnyPattern(normalized, [...DANGEROUS_PATH_PATTERNS, ...configExcludes]);

  if (denylisted && !isAllowed) {
    return {
      ok: false,
      reason: "denylisted",
      sensitive_path: sensitivePath,
      path: sanitizedPath(normalized)
    };
  }

  return { ok: true, reason: null, sensitive_path: false, path: normalized };
}

export function scanBuffer(relativePath, buffer, allowFiles = new Set()) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (isAbsoluteDeniedPath(normalized)) {
    return {
      ok: false,
      reason: "forbidden_env_file",
      sensitive_path: true,
      path: sanitizedPath(normalized)
    };
  }

  const isAllowed = allowFiles.has(normalized);

  if (buffer.subarray(0, 8192).includes(0)) {
    return { ok: false, reason: "binary", sensitive_path: isSensitivePath(normalized), path: sanitizedPath(normalized) };
  }

  const text = buffer.toString("utf8");
  if (!isAllowed) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(text)) {
        return {
          ok: false,
          reason: `secret_scan:${pattern.reason}`,
          sensitive_path: isSensitivePath(normalized),
          path: sanitizedPath(normalized)
        };
      }
    }

    if (containsHighEntropyCandidate(text)) {
      return {
        ok: false,
        reason: "secret_scan:high-entropy-string",
        sensitive_path: isSensitivePath(normalized),
        path: sanitizedPath(normalized)
      };
    }
  }

  return { ok: true, reason: null, sensitive_path: false, path: normalized };
}

function containsHighEntropyCandidate(text) {
  const candidates = text.match(/[A-Za-z0-9_+/=-]{48,}/g) || [];
  return candidates.some((candidate) => {
    if (/^[0-9]+$/.test(candidate)) return false;
    if (/^[A-Za-z]+$/.test(candidate)) return false;
    return shannonEntropy(candidate) >= 4.25;
  });
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) {
    counts.set(char, (counts.get(char) || 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isSensitivePath(relativePath) {
  const lower = relativePath.toLowerCase();
  return /(^|\/)\.env/.test(lower)
    || /(^|[\/._-])(secret|credential|credentials|token|service[-_]?account|private|customer|customers|prod|production|pii|cookie|login data)([\/._-]|$)/.test(lower)
    || /customer.*export|export.*customer|production.*log|prod.*log|private.*data/.test(lower)
    || [".pem", ".key", ".p12", ".pfx", ".sqlite", ".sqlite3", ".db", ".dump", ".log"].includes(path.extname(lower));
}

function isAbsoluteDeniedPath(relativePath) {
  return matchesAnyPattern(relativePath, ABSOLUTE_DENY_PATH_PATTERNS);
}

function sanitizedPath(relativePath) {
  if (!isSensitivePath(relativePath)) return relativePath;
  return "[sensitive-path-redacted]";
}
