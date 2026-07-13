import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

export function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function randomHex(bytes = 4) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function slugify(value, fallback = "unnamed") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || fallback;
}

export function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

export function resolveInside(rootDir, userPath) {
  const resolved = path.resolve(rootDir, userPath);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes repository root: ${userPath}`);
  }
  return { absolutePath: resolved, relativePath: toPosixPath(relative || ".") };
}

export async function readFileBuffer(filePath) {
  return fs.readFile(filePath);
}

export async function listFilesRecursive(rootDir, startRel = ".") {
  const start = path.resolve(rootDir, startRel);
  const out = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = toPosixPath(path.relative(rootDir, absolute));
      if (entry.isDirectory()) {
        out.push({ relativePath: `${relative}/`, absolutePath: absolute, type: "directory" });
        await walk(absolute);
      } else if (entry.isFile()) {
        out.push({ relativePath: relative, absolutePath: absolute, type: "file" });
      }
    }
  }

  await walk(start);
  return out;
}
