import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRemoteJWKSet, jwtVerify } from "jose";

const execFileAsync = promisify(execFile);
const HOST = "127.0.0.1";
const PORT = Number(process.env.AI3D_PORT || 43127);
const ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = ISSUER + "/api/accounts/authorize";
const TOKEN_URL = ISSUER + "/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
const APP_NAME = "AI 3D Studio";
const APP_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, "AI 3D Studio")
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "ai-3d-studio");
const HOST_FILE = path.join(APP_DIR, "host-id");
const CREDS_FILE = path.join(APP_DIR, "chatgpt-plan.json");
const ALLOWED_ORIGINS = new Set([
  "https://swagga5aur.github.io",
  "http://127.0.0.1:1420",
  "http://localhost:1420",
  "http://tauri.localhost",
  "https://tauri.localhost"
]);
const jwks = createRemoteJWKSet(new URL("https://auth.openai.com/.well-known/jwks.json"));
let pendingAuth = null;
let refreshPromise = null;

async function ensureDir() {
  await fs.mkdir(APP_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(APP_DIR, 0o700);
}
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function writePrivate(file, value) {
  const temp = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(temp, 0o600);
  await fs.rename(temp, file);
}
async function hostId() {
  await ensureDir();
  let id = await fs.readFile(HOST_FILE, "utf8").catch(() => "");
  if (!id.trim()) {
    id = "urn:uuid:" + randomUUID();
    await fs.writeFile(HOST_FILE, id, { mode: 0o600 });
    if (process.platform !== "win32") await fs.chmod(HOST_FILE, 0o600);
  }
  return id.trim();
}
async function credentials() { await ensureDir(); return readJson(CREDS_FILE); }
async function saveCredentials(value) { await ensureDir(); await writePrivate(CREDS_FILE, value); }

function randomValue(bytes = 32) { return randomBytes(bytes).toString("base64url"); }
function htmlPage(title, message) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>${title}</title><style>body{font:16px system-ui;background:#10151d;color:#e9eef5;display:grid;place-items:center;min-height:90vh}
  main{max-width:520px;padding:32px;border:1px solid #303b4b;border-radius:14px;background:#18212d}h1{font-size:22px}</style>
  <main><h1>${title}</h1><p>${message}</p><p>You can close this tab and return to AI 3D Studio.</p></main>`;
}
function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
function openBrowser(url) {
  if (process.platform === "win32") return execFileAsync("cmd", ["/c", "start", "", url]);
  if (process.platform === "darwin") return execFileAsync("open", [url]);
  return execFileAsync("xdg-open", [url]);
}
async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new Error("Request body too large.");
  }
  return raw ? JSON.parse(raw) : {};
}
function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true; // local CLI / native app
  if (!ALLOWED_ORIGINS.has(origin)) return false;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-max-age", "600");
  return true;
}
async function beginAuth() {
  if (pendingAuth) throw new Error("A ChatGPT sign-in is already in progress.");
  const current = await credentials();
  const redirectUri = `http://127.0.0.1:${PORT}/auth/callback`;
  const state = randomValue();
  const nonce = randomValue();
  const verifier = randomValue(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const isNew = !current?.client_id;
  const clientId = isNew ? "dynamic_agent_client" : current.client_id;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: challenge,
    ext_agent_host_id: await hostId()
  });
  if (isNew) params.set("agent_name_hint", APP_NAME);
  else {
    if (current.id_token) params.set("id_token_hint", current.id_token);
    if (current.email) params.set("login_hint", current.email);
  }
  pendingAuth = { state, nonce, verifier, redirectUri, clientId, isNew, startedAt: Date.now() };
  const url = AUTHORIZE_URL + "?" + params.toString();
  try { await openBrowser(url); }
  catch { pendingAuth = null; throw new Error("Could not open the system browser. OpenAI sign-in URL could not be launched."); }
}
async function exchangeCode(code, auth, issuedClientId) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: auth.redirectUri,
    client_id: issuedClientId,
    code_verifier: auth.verifier,
    resource: RESOURCE
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: form
  });
  if (!response.ok) throw new Error(`OpenAI token exchange failed (${response.status}). Start sign-in again.`);
  return response.json();
}
async function finishAuth(url, res) {
  const auth = pendingAuth;
  pendingAuth = null; // one-time transaction, including all failure paths
  if (!auth || Date.now() - auth.startedAt > 10 * 60_000 || url.searchParams.get("state") !== auth.state) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    return res.end(htmlPage("Sign-in could not be verified", "The sign-in request expired or did not match. Please try again."));
  }
  if (url.searchParams.has("error")) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    return res.end(htmlPage("Sign-in was cancelled", "No ChatGPT plan access was connected."));
  }
  const code = url.searchParams.get("code");
  const returnedClientId = url.searchParams.get("client_id");
  const clientId = auth.isNew ? returnedClientId : auth.clientId;
  if (!code || !clientId || (returnedClientId && returnedClientId !== clientId)) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    return res.end(htmlPage("Sign-in could not be completed", "The authorization response was incomplete. Please try again."));
  }
  try {
    const tokens = await exchangeCode(code, auth, clientId);
    const scopes = String(tokens.scope || "").split(/\s+/).filter(Boolean);
    if (!scopes.includes("chatgpt.tokens.use.direct")) throw new Error("ChatGPT plan usage permission was not granted. Reconnect and approve plan usage.");
    if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token) throw new Error("OpenAI did not return the required plan-usage credentials.");
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: ISSUER, audience: clientId, requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5
    });
    if (payload.nonce !== auth.nonce || typeof payload.sub !== "string" || !payload.sub) throw new Error("The identity token could not be verified.");
    const old = await credentials();
    if (!auth.isNew && old?.subject && old.subject !== payload.sub) throw new Error("The selected ChatGPT account changed during sign-in. Nothing was overwritten.");
    await saveCredentials({
      issuer: ISSUER, subject: payload.sub, email: payload.email || null, name: payload.name || null,
      client_id: clientId, ext_agent_host_id: await hostId(), id_token: tokens.id_token,
      access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      token_type: tokens.token_type || "Bearer", expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000,
      scopes, saved_at: new Date().toISOString()
    });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(htmlPage("ChatGPT connected", "AI 3D Studio can now use eligible requests through your ChatGPT plan."));
  } catch (e) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(htmlPage("Sign-in failed", String(e?.message || "The connection could not be completed.")));
  }
}
async function getAccessToken() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    let saved = await credentials();
    if (!saved?.refresh_token) throw new Error("Connect ChatGPT in AI 3D Studio Settings first.");
    if (saved.expires_at > Date.now() + 120_000) return saved.access_token;
    const form = new URLSearchParams({
      grant_type: "refresh_token", client_id: saved.client_id,
      refresh_token: saved.refresh_token, resource: RESOURCE
    });
    const response = await fetch(TOKEN_URL, {
      method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: form
    });
    if (!response.ok) throw new Error(`ChatGPT session renewal failed (${response.status}). Reconnect ChatGPT in Settings.`);
    const next = await response.json();
    saved = {
      ...saved, access_token: next.access_token, refresh_token: next.refresh_token || saved.refresh_token,
      id_token: next.id_token || saved.id_token,
      expires_at: Date.now() + Number(next.expires_in || 3600) * 1000,
      scopes: String(next.scope || saved.scopes.join(" ")).split(/\s+/).filter(Boolean),
      saved_at: new Date().toISOString()
    };
    await saveCredentials(saved);
    return saved.access_token;
  })();
  try { return await refreshPromise; } finally { refreshPromise = null; }
}
async function streamResponse(body) {
  const token = await getAccessToken();
  const response = await fetch(RESOURCE + "/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ ...body, store: false, stream: true })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`ChatGPT request failed (${response.status}): ${detail.slice(0, 1200)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const event of events) {
      const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      if (parsed.type === "response.completed") completed = parsed.response;
      if (parsed.type === "response.failed") throw new Error(parsed.response?.error?.message || "ChatGPT response failed.");
      if (parsed.type === "response.incomplete") throw new Error(`ChatGPT response was incomplete: ${parsed.response?.incomplete_details?.reason || "unknown reason"}.`);
      if (parsed.type === "error") throw new Error(parsed.message || "ChatGPT stream failed.");
    }
    if (done) break;
  }
  if (!completed) throw new Error("ChatGPT stream ended without a completed response.");
  return completed;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!cors(req, res)) return send(res, 403, { error: "Origin not allowed." });
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, service: "ai-3d-studio-local-runtime" });
    if (req.method === "GET" && url.pathname === "/status") {
      const saved = await credentials();
      return send(res, 200, { connected: !!saved?.refresh_token, email: saved?.email || null, name: saved?.name || null });
    }
    if (req.method === "POST" && url.pathname === "/auth/start") {
      await beginAuth();
      return send(res, 200, { started: true });
    }
    if (req.method === "GET" && url.pathname === "/auth/callback") return finishAuth(url, res);
    if (req.method === "POST" && url.pathname === "/auth/disconnect") {
      const saved = await credentials();
      if (saved?.refresh_token) {
        const discovery = await fetch(ISSUER + "/.well-known/openid-configuration").then(r => r.json());
        await fetch(discovery.revocation_endpoint, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: saved.refresh_token, token_type_hint: "refresh_token", client_id: saved.client_id })
        }).catch(() => {});
      }
      await fs.rm(CREDS_FILE, { force: true });
      return send(res, 200, { connected: false });
    }
    if (req.method === "GET" && url.pathname === "/models") {
      const token = await getAccessToken();
      const response = await fetch(RESOURCE + "/models", { headers: { authorization: `Bearer ${token}` } });
      const data = await response.json();
      if (!response.ok) return send(res, response.status, { error: data?.error?.message || "Could not list models." });
      return send(res, 200, { models: (data.models || []).filter(m => m.visibility === "list").map(m => ({ id: m.slug, name: m.display_name })) });
    }
    if (req.method === "POST" && url.pathname === "/responses") {
      const body = await readBody(req);
      const response = await streamResponse(body);
      return send(res, 200, response);
    }
    return send(res, 404, { error: "Not found." });
  } catch (e) {
    return send(res, 500, { error: e instanceof Error ? e.message : "Local runtime error." });
  }
});
server.listen(PORT, HOST, () => {
  console.log(`AI 3D Studio local runtime listening on http://${HOST}:${PORT}`);
  console.log("Keep this process running while using the GitHub Pages app.");
});
