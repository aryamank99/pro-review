export function matchesAnyPattern(relativePath, patterns = []) {
  return patterns.some((pattern) => matchesPattern(relativePath, pattern));
}

export function matchesPattern(relativePath, pattern) {
  const path = normalizePath(relativePath);
  const pat = normalizePath(pattern);
  if (!pat) return false;

  if (pat.endsWith("/**")) {
    const prefix = pat.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }

  if (pat.startsWith("**/")) {
    const suffix = pat.slice(3);
    if (matchesPattern(path, suffix)) return true;
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      if (matchesPattern(parts.slice(i).join("/"), suffix)) return true;
    }
    return false;
  }

  if (pat.includes("*") || pat.includes("{")) {
    return globToRegExp(pat).test(path);
  }

  return path === pat || path.startsWith(`${pat}/`);
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function globToRegExp(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    const next = pattern[i + 1];

    if (char === "*" && next === "*" && pattern[i + 2] === "/") {
      out += "(?:.*/)?";
      i += 2;
    } else if (char === "*" && next === "*") {
      out += ".*";
      i += 1;
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        out += "\\{";
      } else {
        const choices = pattern.slice(i + 1, end).split(",").map(escapeRegExp).join("|");
        out += `(?:${choices})`;
        i = end;
      }
    } else {
      out += escapeRegExp(char);
    }
  }
  out += "$";
  return new RegExp(out);
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
