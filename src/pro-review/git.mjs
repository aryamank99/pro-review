import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256 } from "./fs-utils.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  return stdout.trimEnd();
}

export async function getGitInfo(cwd, baseRef = null) {
  try {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const head = await git(cwd, ["rev-parse", "HEAD"]).catch(() => null);
    const status = await git(cwd, ["status", "--porcelain=v1"]).catch(() => "");
    const diff = await git(cwd, ["diff", "--no-ext-diff", "--"]).catch(() => "");
    const stagedDiff = await git(cwd, ["diff", "--cached", "--no-ext-diff", "--"]).catch(() => "");
    const changedTracked = await git(cwd, ["diff", "--name-only", "--"]).catch(() => "");
    const changedStaged = await git(cwd, ["diff", "--cached", "--name-only", "--"]).catch(() => "");
    const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"]).catch(() => "");
    const base = await resolveBaseRef(cwd, baseRef);
    const mergeBase = base.mergeBase;
    const committedDiff = mergeBase ? await git(cwd, ["diff", "--no-ext-diff", `${mergeBase}..HEAD`, "--"]).catch(() => "") : "";
    const changedCommitted = mergeBase ? await git(cwd, ["diff", "--name-only", `${mergeBase}..HEAD`, "--"]).catch(() => "") : "";
    const committedNameStatus = mergeBase ? await git(cwd, ["diff", "--name-status", `${mergeBase}..HEAD`, "--"]).catch(() => "") : "";
    const committedFiles = uniqueLines(changedCommitted);
    const committedStatusByFile = parseNameStatus(committedNameStatus);
    const committedDeletedFiles = [...committedStatusByFile.entries()]
      .filter(([, statusCode]) => statusCode === "D")
      .map(([file]) => file)
      .sort();
    const unstagedFiles = uniqueLines(changedTracked);
    const stagedFiles = uniqueLines(changedStaged);

    return {
      isGitRepo: true,
      root,
      base_ref: base.baseRef,
      merge_base: mergeBase,
      git_head: head,
      working_tree_dirty: Boolean(status.trim()),
      status,
      diff_hash: sha256(`${committedDiff}\n${diff}\n${stagedDiff}`),
      changedFiles: uniqueLines(`${changedCommitted}\n${changedTracked}\n${changedStaged}\n${untracked}`),
      committedFiles,
      committedDeletedFiles,
      unstagedFiles,
      stagedFiles,
      untrackedFiles: uniqueLines(untracked)
    };
  } catch {
    return {
      isGitRepo: false,
      root: cwd,
      base_ref: null,
      git_head: null,
      merge_base: null,
      working_tree_dirty: false,
      status: "",
      diff_hash: null,
      changedFiles: [],
      committedFiles: [],
      committedDeletedFiles: [],
      unstagedFiles: [],
      stagedFiles: [],
      untrackedFiles: []
    };
  }
}

function uniqueLines(value) {
  return orderedUniqueLines(value).sort();
}

function orderedUniqueLines(value) {
  return [...new Set(String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

async function resolveBaseRef(cwd, requestedBaseRef) {
  const candidates = requestedBaseRef
    ? [requestedBaseRef]
    : orderedUniqueLines([
      await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => ""),
      "main",
      "master",
      "origin/main",
      "origin/master"
    ].join("\n"));

  for (const candidate of candidates) {
    const mergeBase = await git(cwd, ["merge-base", "HEAD", candidate]).catch(() => null);
    if (mergeBase) return { baseRef: candidate, mergeBase };
  }

  return { baseRef: requestedBaseRef || null, mergeBase: null };
}

function parseNameStatus(value) {
  const out = new Map();
  for (const line of String(value).split(/\r?\n/).filter(Boolean)) {
    const parts = line.split("\t");
    const statusCode = parts[0]?.[0];
    const file = ["R", "C"].includes(statusCode) ? parts[2] : parts[1];
    if (statusCode && file) out.set(file, statusCode);
  }
  return out;
}
