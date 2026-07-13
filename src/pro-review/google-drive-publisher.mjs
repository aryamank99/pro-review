import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DEFAULT_CONFIG } from "./constants.mjs";
import { buildDriveFolderPlan } from "./artifacts.mjs";
import { pathExists, readJson, slugify, writeJson } from "./fs-utils.mjs";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";

export class GoogleDrivePublisherError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "GoogleDrivePublisherError";
    this.details = details;
  }
}

export async function publishRun({
  cwd,
  runId,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  onAuthUrl = (url) => process.stdout.write(`Open this URL to authorize Google Drive publishing:\n${url}\n`),
  authTimeoutMs = 180000
}) {
  if (!fetchImpl) {
    throw new GoogleDrivePublisherError("Google Drive publishing requires fetch support. Use Node 18 or newer.");
  }
  if (!runId) throw new GoogleDrivePublisherError("Missing required runId.");

  const runDir = path.join(cwd, ".pro-review", "runs", runId);
  const manifestPath = path.join(runDir, "manifest.json");
  const publishPath = path.join(runDir, "publish.json");
  const reviewManifestPath = path.join(runDir, "review_manifest.md");
  const reviewBundlePath = path.join(runDir, "review_bundle.md");

  if (!(await pathExists(manifestPath))) {
    throw new GoogleDrivePublisherError(`No pro-review manifest found for run ${runId}.`, { run_id: runId });
  }

  const [manifest, existingPublish, reviewManifest, reviewBundle, config] = await Promise.all([
    readJson(manifestPath),
    readJson(publishPath),
    fs.readFile(reviewManifestPath, "utf8"),
    fs.readFile(reviewBundlePath, "utf8"),
    loadProjectConfig(cwd)
  ]);

  const driveConfig = {
    ...(DEFAULT_CONFIG.drive || {}),
    ...(config.drive || {})
  };
  const repoSlug = slugify(manifest.repo_slug || config.repoSlug || path.basename(cwd));
  const featureSlug = slugify(manifest.feature_slug || "work");
  const folderPlan = existingPublish.folder_plan?.folder_names
    ? existingPublish.folder_plan
    : buildDriveFolderPlan({
      rootFolderName: driveConfig.rootFolderName,
      folderLayout: driveConfig.folderLayout,
      repoSlug,
      featureSlug,
      runId
    });

  const token = await getAccessToken({
    cwd,
    driveConfig,
    fetchImpl,
    onAuthUrl,
    authTimeoutMs
  });
  const client = new DriveClient({ fetchImpl, accessToken: token.access_token });
  const folder = await ensureFolderPath({ client, folderNames: folderPlan.folder_names });

  const manifestDoc = await client.createNativeDocument({
    title: existingPublish.manifest_doc.title,
    folderId: folder.leaf.id,
    content: reviewManifest
  });
  const bundleDoc = await client.createNativeDocument({
    title: existingPublish.bundle_doc.title,
    folderId: folder.leaf.id,
    content: reviewBundle
  });

  const [exportedManifest, exportedBundle] = await Promise.all([
    client.exportText(manifestDoc.id),
    client.exportText(bundleDoc.id)
  ]);

  const verification = {
    marker: manifest.artifact_marker,
    manifest_marker_found: exportedManifest.includes(manifest.artifact_marker),
    bundle_marker_found: exportedBundle.includes(manifest.artifact_marker),
    manifest_doc_id: manifestDoc.id,
    bundle_doc_id: bundleDoc.id,
    verified_at: new Date().toISOString()
  };
  const verifiedMarker = verification.manifest_marker_found && verification.bundle_marker_found;
  const updatedPublish = {
    ...existingPublish,
    status: verifiedMarker ? "published" : "publish_verification_failed",
    folder_status: "created_or_found",
    folder_plan: {
      ...folderPlan,
      path: folder.path,
      folder_ids: folder.folders.map((entry) => ({
        name: entry.name,
        id: entry.id
      }))
    },
    manifest_doc: {
      ...existingPublish.manifest_doc,
      id: manifestDoc.id,
      url: manifestDoc.webViewLink || null,
      folder_id: folder.leaf.id,
      folder_path: folder.path
    },
    bundle_doc: {
      ...existingPublish.bundle_doc,
      id: bundleDoc.id,
      url: bundleDoc.webViewLink || null,
      folder_id: folder.leaf.id,
      folder_path: folder.path
    },
    verified_marker: verifiedMarker,
    verification,
    published_at: new Date().toISOString(),
    note: verifiedMarker
      ? "Published as native Google Docs and verified by Drive export marker readback."
      : "Published artifacts, but marker readback failed. Do not use this run until republished."
  };

  await writeJson(publishPath, updatedPublish);

  if (!verifiedMarker) {
    throw new GoogleDrivePublisherError("Published Google Docs did not pass artifact marker verification.", {
      run_id: runId,
      verification
    });
  }

  return {
    runId,
    runDir,
    publishPath,
    publishMetadata: updatedPublish,
    folder,
    manifestDoc,
    bundleDoc
  };
}

async function loadProjectConfig(cwd) {
  const configPath = path.join(cwd, ".pro-review", "config.json");
  const loaded = (await pathExists(configPath)) ? await readJson(configPath) : {};
  return {
    ...DEFAULT_CONFIG,
    repoSlug: slugify(path.basename(cwd)),
    ...loaded,
    drive: {
      ...(DEFAULT_CONFIG.drive || {}),
      ...(loaded.drive || {})
    }
  };
}

async function getAccessToken({ cwd, driveConfig, fetchImpl, onAuthUrl, authTimeoutMs }) {
  const tokenPath = resolveConfigPath(cwd, driveConfig.tokenPath || DEFAULT_CONFIG.drive.tokenPath);
  const existingToken = (await pathExists(tokenPath)) ? await readJson(tokenPath) : null;

  if (isFreshToken(existingToken)) {
    return existingToken;
  }

  const client = await loadOAuthClient({ cwd, driveConfig });

  if (existingToken?.refresh_token) {
    const refreshed = await exchangeToken({
      fetchImpl,
      params: {
        client_id: client.client_id,
        client_secret: client.client_secret,
        refresh_token: existingToken.refresh_token,
        grant_type: "refresh_token"
      }
    });
    const merged = normalizeToken({
      ...existingToken,
      ...refreshed,
      refresh_token: refreshed.refresh_token || existingToken.refresh_token
    });
    await writeJson(tokenPath, merged);
    return merged;
  }

  const authorized = await authorizeWithLoopback({
    client,
    scope: driveConfig.oauthScope || DEFAULT_CONFIG.drive.oauthScope,
    fetchImpl,
    onAuthUrl,
    authTimeoutMs
  });
  await writeJson(tokenPath, authorized);
  return authorized;
}

async function loadOAuthClient({ cwd, driveConfig }) {
  const envClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const envClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (envClientId) {
    return {
      client_id: envClientId,
      client_secret: envClientSecret || ""
    };
  }

  const clientPath = resolveConfigPath(cwd, driveConfig.oauthClientPath || DEFAULT_CONFIG.drive.oauthClientPath);
  if (!(await pathExists(clientPath))) {
    throw new GoogleDrivePublisherError(
      `Missing Google OAuth client credentials. Create ${path.relative(cwd, clientPath)} or set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.`,
      { credential_path: clientPath }
    );
  }

  const raw = await readJson(clientPath);
  const client = raw.installed || raw.web || raw;
  if (!client.client_id) {
    throw new GoogleDrivePublisherError("Google OAuth client credentials are missing client_id.", {
      credential_path: clientPath
    });
  }
  return {
    client_id: client.client_id,
    client_secret: client.client_secret || ""
  };
}

async function authorizeWithLoopback({ client, scope, fetchImpl, onAuthUrl, authTimeoutMs }) {
  const state = crypto.randomBytes(16).toString("hex");
  const { code, redirectUri } = await waitForOAuthCode({ client, scope, state, onAuthUrl, authTimeoutMs });
  return normalizeToken(await exchangeToken({
    fetchImpl,
    params: {
      client_id: client.client_id,
      client_secret: client.client_secret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    }
  }));
}

async function waitForOAuthCode({ client, scope, state, onAuthUrl, authTimeoutMs }) {
  let server;
  let timeout;
  try {
    const callback = new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
        if (requestUrl.pathname !== "/oauth2callback") {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("Not found");
          return;
        }
        if (requestUrl.searchParams.get("state") !== state) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Invalid OAuth state.");
          reject(new GoogleDrivePublisherError("Google OAuth state did not match."));
          return;
        }
        const error = requestUrl.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Google OAuth authorization failed.");
          reject(new GoogleDrivePublisherError(`Google OAuth authorization failed: ${error}`));
          return;
        }
        const code = requestUrl.searchParams.get("code");
        if (!code) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Missing OAuth code.");
          reject(new GoogleDrivePublisherError("Google OAuth callback did not include a code."));
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>Authorized</title><p>Google Drive authorization complete. You can return to Codex.</p>");
        resolve(code);
      });
      server.once("error", reject);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set("client_id", client.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", scope);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", state);
    onAuthUrl(authUrl.toString());

    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new GoogleDrivePublisherError("Timed out waiting for Google OAuth authorization.")), authTimeoutMs);
    });
    const code = await Promise.race([callback, timeoutPromise]);
    return { code, redirectUri };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (server) server.close();
  }
}

async function exchangeToken({ fetchImpl, params }) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) body.set(key, value);
  }
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  return readJsonResponse(response, "Google OAuth token exchange failed");
}

function normalizeToken(token) {
  const expiresInMs = Number(token.expires_in || 0) * 1000;
  const expiresAt = token.expires_at || token.expiry_date || (expiresInMs ? Date.now() + expiresInMs : null);
  return {
    ...token,
    expires_at: expiresAt
  };
}

function isFreshToken(token) {
  if (!token?.access_token) return false;
  const expiresAt = Number(token.expires_at || token.expiry_date || 0);
  return !expiresAt || expiresAt > Date.now() + 60000;
}

async function ensureFolderPath({ client, folderNames }) {
  if (!Array.isArray(folderNames) || folderNames.length === 0) {
    throw new GoogleDrivePublisherError("Drive folder plan did not include folder_names.");
  }

  const folders = [];
  let parentId = "root";
  for (const name of folderNames) {
    const existing = await client.findChildByName({
      parentId,
      name,
      mimeType: GOOGLE_FOLDER_MIME
    });
    const folder = existing || await client.createFolder({ parentId, name });
    folders.push(folder);
    parentId = folder.id;
  }

  return {
    folders,
    leaf: folders[folders.length - 1],
    path: folders.map((folder) => folder.name).join("/")
  };
}

class DriveClient {
  constructor({ fetchImpl, accessToken }) {
    this.fetchImpl = fetchImpl;
    this.accessToken = accessToken;
  }

  async findChildByName({ parentId, name, mimeType }) {
    const params = new URLSearchParams({
      q: [
        `${driveLiteral(parentId)} in parents`,
        `name = ${driveLiteral(name)}`,
        `mimeType = ${driveLiteral(mimeType)}`,
        "trashed = false"
      ].join(" and "),
      spaces: "drive",
      pageSize: "10",
      fields: "files(id,name,mimeType,webViewLink,parents)"
    });
    const result = await this.requestJson(`${DRIVE_API}/files?${params.toString()}`);
    return result.files?.[0] || null;
  }

  async createFolder({ parentId, name }) {
    const metadata = {
      name,
      mimeType: GOOGLE_FOLDER_MIME
    };
    if (parentId !== "root") metadata.parents = [parentId];
    return this.requestJson(`${DRIVE_API}/files?fields=id,name,mimeType,webViewLink,parents`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=UTF-8"
      },
      body: JSON.stringify(metadata)
    });
  }

  async createNativeDocument({ title, folderId, content }) {
    const metadata = {
      name: title,
      mimeType: GOOGLE_DOC_MIME,
      parents: [folderId]
    };
    const boundary = `pro_review_${crypto.randomBytes(12).toString("hex")}`;
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      content,
      `--${boundary}--`,
      ""
    ].join("\r\n");

    return this.requestJson(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,parents`, {
      method: "POST",
      headers: {
        "content-type": `multipart/related; boundary=${boundary}`
      },
      body
    });
  }

  async exportText(fileId) {
    const response = await this.request(`${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=text%2Fplain`);
    if (!response.ok) {
      const body = await response.text();
      throw new GoogleDrivePublisherError("Google Drive export failed", {
        status: response.status,
        body
      });
    }
    return response.text();
  }

  async requestJson(url, options = {}) {
    return readJsonResponse(await this.request(url, options), "Google Drive API request failed");
  }

  async request(url, options = {}) {
    return this.fetchImpl(url, {
      ...options,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        ...(options.headers || {})
      }
    });
  }
}

async function readJsonResponse(response, errorMessage) {
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new GoogleDrivePublisherError(errorMessage, {
      status: response.status,
      body
    });
  }
  return body || {};
}

function driveLiteral(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function resolveConfigPath(cwd, configuredPath) {
  return path.isAbsolute(configuredPath) ? configuredPath : path.join(cwd, configuredPath);
}
