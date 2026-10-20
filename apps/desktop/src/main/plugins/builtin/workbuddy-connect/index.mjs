/**
 * WorkBuddy Connect — DeepWrite plugin.
 *
 * Reuses the sign-in state of the WorkBuddy desktop app on this machine and
 * exposes its models through a loopback OpenAI-compatible endpoint:
 *
 *   DeepWrite  ->  127.0.0.1:<port>/v1/chat/completions  ->  copilot gateway
 *
 * The desktop app stores its tokens in
 * `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`
 * with the sensitive fields wrapped in AES-256-GCM envelopes. The protector
 * key comes from WorkBuddy's own binary, run once as Node with
 * `ELECTRON_RUN_AS_NODE=1`; nothing is written back to WorkBuddy's files.
 *
 * This mirrors the approach of `dsh-workbuddy-connect`, adapted to the
 * DeepWrite plugin host. WorkBuddy's client interface is not a public API and
 * may change; keep this plugin updated alongside the desktop app.
 */

import { createHash, createDecipheriv, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const PROVIDER_ID = "workbuddy";
const PROVIDER_NAME = "WorkBuddy";
const AUTH_RELATIVE = [
  "CodeBuddyExtension",
  "Data",
  "Public",
  "auth",
  "workbuddy-desktop.info"
];
const DEFAULT_ENDPOINT = "https://copilot.tencent.com";
const KEY_HELPER =
  'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';
const CREDENTIAL_TTL_MS = 30_000;
const CATALOG_TTL_MS = 5 * 60_000;
const KEY_TTL_MS = 10 * 60_000;
const MAX_BODY_BYTES = 24 * 1024 * 1024;
/** Thinking levels DeepWrite understands, in ascending effort order. */
const DEEPWRITE_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];

const FALLBACK_MODELS = [
  ["deepseek-v4.1-flash", "DeepSeek-V4.1-Flash", 1_000_000, 128_000],
  ["deepseek-v4-pro", "DeepSeek-V4-Pro", 1_000_000, 128_000],
  ["glm-5.3", "GLM-5.3", 1_000_000, 64_000],
  ["glm-5.3-flash", "GLM-5.3-Flash", 1_000_000, 131_072],
  ["glm-5.2", "GLM-5.2", 1_000_000, 64_000],
  ["kimi-k3-1", "Kimi-K3", 1_000_000, 32_000],
  ["minimax-m3", "MiniMax-M3", 512_000, 64_000],
  ["hy3", "Hy3", 192_000, 64_000]
].map(([id, label, contextWindow, maxTokens]) => ({
  id,
  label,
  contextWindow,
  maxTokens
}));

let context;
let server;
let proxyToken;
let proxyPort;
let credentialCache;
let catalogCache;
let protectorKeyCache;
let appVersion = "0.0.0";

export async function activate(pluginContext) {
  context = pluginContext;
  appVersion = await readWorkBuddyVersion();
  catalogCache = undefined;
  credentialCache = undefined;
  proxyToken = randomUUID().replace(/-/gu, "");
  proxyPort = await startProxy();
  const catalog = await loadCatalog();
  const credential = await readCredential().catch((error) => ({ error }));
  if (credential?.error) {
    context.status.set(credentialStatus(credential.error, catalog));
    context.logger.warn("WorkBuddy credential unavailable", {
      reason: credential.error.message
    });
    return;
  }
  await context.models.registerProvider({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: `http://127.0.0.1:${proxyPort}/v1`,
    apiKey: proxyToken,
    models: catalog.models.map((model) => ({
      id: model.id,
      label: model.label,
      ...(model.contextWindow && model.maxTokens
        ? { contextWindow: model.contextWindow, maxTokens: model.maxTokens }
        : {}),
      ...(model.reasoning
        ? {
            reasoning: true,
            ...(model.defaultThinkingLevel
              ? { defaultThinkingLevel: model.defaultThinkingLevel }
              : {})
          }
        : {})
    }))
  });
  context.status.set([
    { label: "账号", value: accountLabel(credential) },
    { label: "登录有效期", value: expiryLabel(credential.expiresAt) },
    {
      label: "模型",
      value: `${catalog.models.length} 个（${catalog.source}）`
    },
    { label: "代理地址", value: `127.0.0.1:${proxyPort}` }
  ]);
  context.logger.info("WorkBuddy proxy ready", {
    port: proxyPort,
    models: catalog.models.length
  });
}

export async function deactivate() {
  const active = server;
  server = undefined;
  if (active) {
    await new Promise((resolve) => active.close(() => resolve(undefined)));
  }
  await context?.models.unregisterProvider(PROVIDER_ID).catch(() => undefined);
  context?.status.set([]);
  context = undefined;
}

/* ------------------------------------------------------------------ */
/* WorkBuddy credentials                                               */
/* ------------------------------------------------------------------ */

async function readCredential() {
  if (
    credentialCache &&
    Date.now() - credentialCache.readAt < CREDENTIAL_TTL_MS
  ) {
    return credentialCache.value;
  }
  const file = await findAuthFile();
  if (!file) {
    throw new Error(
      "未找到 WorkBuddy 登录凭据。请先打开并登录 WorkBuddy 桌面端，然后点击「重新加载」。"
    );
  }
  const document = JSON.parse(await readFile(file, "utf8"));
  const auth = document?.auth ?? {};
  const accessToken = await openField(auth.accessToken);
  if (!accessToken) {
    throw new Error(
      "WorkBuddy 登录凭据已过期或无法解密。请重新登录 WorkBuddy 后再试。"
    );
  }
  const value = {
    accessToken,
    expiresAt: Number(auth.expiresAt) || 0,
    domain: typeof auth.domain === "string" ? auth.domain : "",
    uid: typeof document?.account?.uid === "string" ? document.account.uid : "",
    file
  };
  credentialCache = { value, readAt: Date.now() };
  return value;
}

function invalidateCredential() {
  credentialCache = undefined;
}

async function findAuthFile() {
  const explicit = process.env.WORKBUDDY_AUTH_FILE?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const roots = [process.env.LOCALAPPDATA, process.env.APPDATA].filter(
    (root) => typeof root === "string" && root.trim()
  );
  const candidates = roots.map((root) => join(root, ...AUTH_RELATIVE));
  candidates.push(
    join(homedir(), "Library", "Application Support", ...AUTH_RELATIVE),
    join(homedir(), ".config", ...AUTH_RELATIVE)
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function openField(wrapped) {
  if (typeof wrapped === "string") return wrapped;
  if (!wrapped || wrapped.$wbEncrypted !== 1) return undefined;
  const envelope = JSON.parse(
    Buffer.from(String(wrapped.envelope), "base64").toString("utf8")
  );
  if (envelope.suite !== 1) {
    throw new Error("WorkBuddy 使用了未知的凭据加密格式。");
  }
  const key = await protectorKey();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.nonce, "base64"),
    { authTagLength: 16 }
  );
  decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function buildAuthenticatedContextAad(keyId, suite) {
  const prefix = Buffer.from("WB-AAD\0", "ascii");
  const lengthPrefixed = (value) => {
    const bytes = Buffer.from(value, "utf8");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(bytes.length);
    return Buffer.concat([header, bytes]);
  };
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    prefix,
    Buffer.from([1]),
    lengthPrefixed("WBEV1"),
    lengthPrefixed("sym-v1"),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0])
  ]);
}

async function protectorKey() {
  if (protectorKeyCache && Date.now() - protectorKeyCache.readAt < KEY_TTL_MS) {
    return protectorKeyCache.key;
  }
  const binary = findWorkBuddyBinary();
  if (!binary) {
    throw new Error(
      "无法定位 WorkBuddy 可执行文件。请设置环境变量 WORKBUDDY_ELECTRON_BIN 指向 WorkBuddy.exe 后重启 DeepWrite。"
    );
  }
  const payload = await new Promise((resolve, reject) => {
    execFile(
      binary,
      ["-e", KEY_HELPER],
      {
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      },
      (error, stdout) => {
        if (error) {
          reject(new Error(`读取 WorkBuddy 本机密钥失败：${error.message}`));
          return;
        }
        try {
          resolve(JSON.parse(String(stdout).trim()));
        } catch {
          reject(new Error("WorkBuddy 本机密钥返回了无法解析的内容。"));
        }
      }
    );
  });
  const secret = payload?.atRestSecretKey;
  if (typeof secret !== "string" || !secret) {
    throw new Error("WorkBuddy 本机密钥不可用，请确认桌面端已正常登录。");
  }
  const key = createHash("sha256").update(secret, "utf8").digest();
  protectorKeyCache = { key, readAt: Date.now() };
  return key;
}

function findWorkBuddyBinary() {
  const explicit = process.env.WORKBUDDY_ELECTRON_BIN?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy",
      join(homedir(), "Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy")
    );
  } else if (process.platform === "win32") {
    for (const root of windowsProgramRoots()) {
      candidates.push(
        join(root, "WorkBuddy", "WorkBuddy.exe"),
        join(root, "Tencent", "WorkBuddy", "WorkBuddy.exe")
      );
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(
        join(process.env.LOCALAPPDATA, "Programs", "WorkBuddy", "WorkBuddy.exe")
      );
    }
  } else {
    candidates.push(
      "/opt/WorkBuddy/workbuddy",
      "/usr/bin/workbuddy",
      join(homedir(), ".local/bin/workbuddy")
    );
  }
  return candidates.find((candidate) => existsSync(candidate));
}

function windowsProgramRoots() {
  const roots = new Set();
  for (const variable of [
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432"
  ]) {
    const value = process.env[variable];
    if (value?.trim()) roots.add(value);
  }
  // Per-machine installs may live on a drive other than C:.
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    if (!existsSync(drive)) continue;
    roots.add(join(drive, "Program Files"));
    roots.add(join(drive, "Program Files (x86)"));
  }
  return [...roots];
}

async function readWorkBuddyVersion() {
  try {
    const raw = await readFile(
      join(configDirectory(), "last-launch.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function configDirectory() {
  return (
    process.env.WORKBUDDY_CONFIG_DIR?.trim() || join(homedir(), ".workbuddy")
  );
}

/* ------------------------------------------------------------------ */
/* Model catalog                                                       */
/* ------------------------------------------------------------------ */

async function loadCatalog() {
  if (catalogCache && Date.now() - catalogCache.readAt < CATALOG_TTL_MS) {
    return catalogCache.value;
  }
  const fromDisk = await readCatalogFromDisk();
  const value = fromDisk ?? {
    endpoint: DEFAULT_ENDPOINT,
    source: "内置列表",
    models: FALLBACK_MODELS
  };
  catalogCache = { value, readAt: Date.now() };
  return value;
}

async function readCatalogFromDisk() {
  const directory = join(configDirectory(), "local_storage");
  const names = await readdir(directory).catch(() => []);
  for (const name of names) {
    if (!name.endsWith(".info")) continue;
    const raw = await readFile(join(directory, name), "utf8").catch(
      () => undefined
    );
    if (!raw || !raw.includes('"models"')) continue;
    try {
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        const data = entry?.data ?? entry;
        const models = normalizeCatalogModels(data?.models);
        if (!models.length) continue;
        return {
          endpoint:
            typeof data.endpoint === "string" && data.endpoint.trim()
              ? data.endpoint.trim()
              : DEFAULT_ENDPOINT,
          source: "WorkBuddy 客户端缓存",
          models
        };
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Catalog tags that mark a model as media generation instead of chat. */
const NON_CHAT_TAGS = new Set([
  "text-to-image",
  "image-to-image",
  "image-edit",
  "text-to-video",
  "image-to-video",
  "text-to-speech"
]);

function normalizeCatalogModels(models) {
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  const normalized = [];
  for (const model of models) {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    const label =
      typeof model?.name === "string" && model.name.trim()
        ? model.name.trim()
        : id;
    if (!id || seen.has(id)) continue;
    if (id.startsWith("completion") || id.endsWith("-completion")) continue;
    if (isNonChatModel(model)) continue;
    seen.add(id);
    const contextWindow = clampWindow(model?.maxInputTokens);
    const maxTokens = clampOutput(model?.maxOutputTokens, contextWindow);
    const reasoning = model?.supportsReasoning === true;
    const defaultThinkingLevel = reasoning
      ? mapThinkingEffort(model)
      : undefined;
    normalized.push({
      id,
      label,
      ...(contextWindow && maxTokens ? { contextWindow, maxTokens } : {}),
      ...(reasoning
        ? {
            reasoning: true,
            ...(defaultThinkingLevel ? { defaultThinkingLevel } : {})
          }
        : {})
    });
  }
  return normalized.slice(0, 100);
}

/**
 * Image and video models in the client catalog carry no chat metadata at all,
 * so they would only produce confusing 400s in the model picker.
 */
function isNonChatModel(model) {
  const tags = Array.isArray(model?.tags) ? model.tags : [];
  if (tags.some((tag) => NON_CHAT_TAGS.has(String(tag)))) return true;
  const hasChatMetadata =
    typeof model?.vendor === "string" ||
    Number(model?.maxInputTokens) > 0 ||
    model?.supportsToolCall === true;
  return !hasChatMetadata;
}

function mapThinkingEffort(model) {
  const reasoning = model?.reasoning;
  const effort =
    typeof reasoning?.defaultEffort === "string"
      ? reasoning.defaultEffort
      : typeof reasoning?.effort === "string"
        ? reasoning.effort
        : "";
  return DEEPWRITE_THINKING_LEVELS.includes(effort) ? effort : undefined;
}

function clampWindow(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1_024) return undefined;
  return Math.min(Math.floor(parsed), 10_000_000);
}

function clampOutput(value, contextWindow) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  if (!contextWindow) return undefined;
  return Math.min(Math.floor(parsed), contextWindow);
}

/* ------------------------------------------------------------------ */
/* Loopback proxy                                                      */
/* ------------------------------------------------------------------ */

async function startProxy() {
  server = http.createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 502, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "workbuddy_proxy_error"
        }
      });
    });
  });
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("无法取得本地代理端口。"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function handleRequest(request, response) {
  if (!authorized(request)) {
    sendJson(response, 401, {
      error: { message: "DeepWrite 插件代理令牌无效。", type: "unauthorized" }
    });
    return;
  }
  const path = (request.url ?? "").split("?")[0];
  if (request.method === "GET" && /\/v1\/models\/?$/u.test(path)) {
    const catalog = await loadCatalog();
    sendJson(response, 200, {
      object: "list",
      data: catalog.models.map((model) => ({
        id: model.id,
        object: "model",
        owned_by: "workbuddy",
        ...(model.contextWindow
          ? {
              context_window: model.contextWindow,
              max_output_tokens: model.maxTokens
            }
          : {})
      }))
    });
    return;
  }
  if (
    request.method === "POST" &&
    /(\/v1)?\/chat\/completions\/?$/u.test(path)
  ) {
    await proxyChat(request, response);
    return;
  }
  sendJson(response, 404, {
    error: { message: `未知的代理路径：${path}`, type: "not_found" }
  });
}

function authorized(request) {
  const header = request.headers.authorization ?? "";
  return proxyToken && header === `Bearer ${proxyToken}`;
}

async function proxyChat(request, response) {
  const payload = await readJsonBody(request);
  const wantsStream = payload.stream === true;
  const upstream = await callUpstream(payload);
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    sendJson(response, upstream.status, upstreamError(detail, upstream.status));
    return;
  }
  if (wantsStream) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (response.destroyed || response.writableEnded) break;
        if (value) response.write(Buffer.from(value));
      }
    } finally {
      if (!response.writableEnded) response.end();
    }
    return;
  }
  const chunks = [];
  for await (const chunk of readSseChunks(upstream.body)) chunks.push(chunk);
  sendJson(response, 200, aggregateChunks(chunks));
}

async function callUpstream(payload, retried = false) {
  const credential = await readCredential();
  const catalog = await loadCatalog();
  const response = await fetch(
    `${catalog.endpoint.replace(/\/+$/u, "")}/v2/chat/completions`,
    {
      method: "POST",
      headers: upstreamHeaders(credential.accessToken),
      body: JSON.stringify({ ...payload, stream: true })
    }
  );
  if (response.status === 401 && !retried) {
    await response.body?.cancel().catch(() => undefined);
    invalidateCredential();
    return await callUpstream(payload, true);
  }
  return response;
}

function upstreamHeaders(accessToken) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-requested-with": "XMLHttpRequest",
    Authorization: `Bearer ${accessToken}`,
    "X-Conversation-ID": randomUUID(),
    "X-Conversation-Request-ID": randomUUID(),
    "acp-connection-id": randomUUID(),
    "X-Conversation-Message-ID": randomUUID(),
    "X-Request-ID": randomUUID(),
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "x-codebuddy-request": "1",
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Version": appVersion,
    "X-Private-Data": "true",
    "X-Product": "SaaS",
    "User-Agent": `WorkBuddy/${appVersion} WorkBuddy/${appVersion}`
  };
  if (credentialDomain()) headers["X-Domain"] = credentialDomain();
  return headers;
}

function credentialDomain() {
  return credentialCache?.value?.domain ?? "";
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("请求体过大，已拒绝转发。");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求体不是合法的 JSON。");
  }
}

async function* readSseChunks(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/u, "");
      buffer = buffer.slice(index + 1);
      const payload = ssePayload(line);
      if (payload) yield payload;
      index = buffer.indexOf("\n");
    }
  }
  const tail = ssePayload(buffer.replace(/\r$/u, ""));
  if (tail) yield tail;
}

function ssePayload(line) {
  if (!line.startsWith("data:")) return undefined;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function aggregateChunks(chunks) {
  let id = "";
  let model = "";
  let created = Math.floor(Date.now() / 1000);
  let finishReason = "stop";
  let usage;
  let content = "";
  let reasoning = "";
  const toolCalls = new Map();
  for (const chunk of chunks) {
    if (chunk?.id) id = chunk.id;
    if (chunk?.model) model = chunk.model;
    if (typeof chunk?.created === "number") created = chunk.created;
    if (chunk?.usage) usage = chunk.usage;
    for (const choice of chunk?.choices ?? []) {
      const delta = choice?.delta ?? {};
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") {
        reasoning += delta.reasoning_content;
      }
      for (const call of delta.tool_calls ?? []) {
        const index = typeof call.index === "number" ? call.index : 0;
        const current = toolCalls.get(index) ?? {
          id: "",
          type: "function",
          function: { name: "", arguments: "" }
        };
        if (call.id) current.id = call.id;
        if (call.type) current.type = call.type;
        if (call.function?.name) current.function.name += call.function.name;
        if (call.function?.arguments) {
          current.function.arguments += call.function.arguments;
        }
        toolCalls.set(index, current);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  }
  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, value]) => value);
  }
  return {
    id: id || `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {})
  };
}

function upstreamError(detail, status) {
  let message = detail?.slice(0, 500) || `WorkBuddy 返回了 ${status}`;
  try {
    const parsed = JSON.parse(detail);
    if (typeof parsed?.msg === "string") message = parsed.msg;
    else if (typeof parsed?.error?.message === "string") {
      message = parsed.error.message;
    }
  } catch {
    // Keep the raw text when the gateway did not answer with JSON.
  }
  return {
    error: { message, type: "workbuddy_upstream_error", status }
  };
}

function sendJson(response, status, payload) {
  if (response.headersSent || response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

/* ------------------------------------------------------------------ */
/* Status text                                                         */
/* ------------------------------------------------------------------ */

function credentialStatus(error, catalog) {
  const message = error instanceof Error ? error.message : String(error);
  return [
    { label: "账号", value: "未连接" },
    { label: "登录有效期", value: "—" },
    {
      label: "模型",
      value: `${catalog.models.length} 个（${catalog.source}）`
    },
    { label: "提示", value: message }
  ];
}

function accountLabel(credential) {
  if (credential.uid)
    return `${credential.domain || "workbuddy"} · ${credential.uid.slice(0, 8)}`;
  return credential.domain || "已登录";
}

function expiryLabel(expiresAt) {
  if (!expiresAt) return "未知";
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "未知";
  const expired = date.getTime() <= Date.now();
  const text = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return expired ? `已过期（${text}）` : `${text} 到期`;
}
