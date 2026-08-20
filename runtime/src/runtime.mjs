import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

export const RUNTIME_VERSION = "0.2.0";

/** Exit codes are intentionally stable so scripts can offer a useful fix. */
export const EXIT_CODES = Object.freeze({
  OK: 0,
  INVALID_ARGUMENTS: 2,
  CONFIGURATION: 3,
  RUNTIME_NOT_INSTALLED: 10,
  RUNTIME_NOT_RUNNING: 11,
  MODEL_NOT_READY: 12,
  VERSION_MISMATCH: 13,
  MODEL_CONSENT_REQUIRED: 14,
  DEPENDENCY_ERROR: 15,
  SERVICE_START_ERROR: 16,
  PROCESS_CONFLICT: 17,
});

export class RuntimeError extends Error {
  constructor(code, message, { exitCode = EXIT_CODES.CONFIGURATION, fix, details } = {}) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.exitCode = exitCode;
    this.fix = fix;
    this.details = details;
  }
}

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(moduleRoot, "..");

function envPath(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function defaultStateDir() {
  if (process.platform === "win32") {
    return path.join(envPath("LOCALAPPDATA") || path.join(os.homedir(), "AppData", "Local"), "dsh-local-ocr-runtime");
  }
  return path.join(envPath("XDG_STATE_HOME") || path.join(os.homedir(), ".local", "state"), "dsh-local-ocr-runtime");
}

function detectServiceDir(explicit) {
  const candidates = [
    explicit,
    envPath("DSH_LOCAL_OCR_SERVICE_DIR"),
    path.join(moduleRoot, "service"),
    path.join(repositoryRoot, "ocr-service"),
    path.join(process.cwd(), "ocr-service"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(path.join(resolved, "pyproject.toml")) && fs.existsSync(path.join(resolved, "src"))) {
      return resolved;
    }
  }
  return undefined;
}

function parseServiceUrl(raw, fallbackPort = 8765) {
  const value = raw || `http://127.0.0.1:${fallbackPort}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeError("OCR_SERVICE_URL_INVALID", `OCR_SERVICE_URL is not a valid URL: ${value}`, {
      fix: "Set OCR_SERVICE_URL to http://127.0.0.1:<port>.",
    });
  }
  if (
    parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" ||
    !["", "/"].includes(parsed.pathname) || parsed.search || parsed.hash ||
    parsed.username || parsed.password || !parsed.port
  ) {
    throw new RuntimeError(
      "OCR_SERVICE_URL_INVALID",
      "OCR_SERVICE_URL must be a pathless loopback http://127.0.0.1:<port> URL.",
      { fix: "Set OCR_SERVICE_URL=http://127.0.0.1:8765." },
    );
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RuntimeError("OCR_SERVICE_URL_INVALID", "OCR_SERVICE_URL contains an invalid port.", {
      fix: "Choose a TCP port from 1 through 65535.",
    });
  }
  return { url: `http://127.0.0.1:${port}`, port };
}

export function getPaths(options = {}) {
  const stateDir = path.resolve(options.stateDir || envPath("DSH_LOCAL_OCR_RUNTIME_HOME") || defaultStateDir());
  const modelCacheDir = path.resolve(
    options.modelCacheDir || envPath("OCR_MODEL_CACHE_DIR") || path.join(stateDir, "models"),
  );
  const requestedUrl = options.url || (options.port ? `http://127.0.0.1:${options.port}` : envPath("OCR_SERVICE_URL"));
  const service = parseServiceUrl(requestedUrl, options.port || Number(envPath("OCR_SERVICE_PORT")) || 8765);
  const serviceDir = detectServiceDir(options.serviceDir);
  const venvDir = path.join(stateDir, "venv");
  return {
    stateDir,
    stateFile: path.join(stateDir, "state.json"),
    configFile: path.join(stateDir, "config.json"),
    consentFile: path.join(stateDir, "model-consent.json"),
    logDir: path.join(stateDir, "logs"),
    logFile: path.join(stateDir, "logs", "ocr-service.log"),
    modelCacheDir,
    venvDir,
    venvPython: process.platform === "win32" ? path.join(venvDir, "Scripts", "python.exe") : path.join(venvDir, "bin", "python"),
    serviceDir,
    appDir: serviceDir ? path.join(serviceDir, "src") : undefined,
    serviceUrl: service.url,
    port: service.port,
  };
}

export async function ensureDirectories(paths) {
  await Promise.all([
    fsp.mkdir(paths.stateDir, { recursive: true }),
    fsp.mkdir(paths.logDir, { recursive: true }),
    fsp.mkdir(paths.modelCacheDir, { recursive: true }),
  ]);
}

async function atomicWriteJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temp, file);
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== undefined) return fallback;
    if (error?.code === "ENOENT") return undefined;
    throw new RuntimeError("RUNTIME_STATE_INVALID", `Could not read runtime state: ${file}`, {
      fix: `Remove or repair ${file}, then run dsh-local-ocr-runtime doctor.`,
      details: { cause: String(error) },
    });
  }
}

export const readState = (paths) => readJson(paths.stateFile);
export const readConfig = (paths) => readJson(paths.configFile);
export const readConsent = (paths) => readJson(paths.consentFile);

export async function writeState(paths, state) {
  await atomicWriteJson(paths.stateFile, state);
}

export async function writeConfig(paths, config) {
  await atomicWriteJson(paths.configFile, config);
}

export async function clearState(paths) {
  try {
    await fsp.unlink(paths.stateFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function parseVersion(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0) } : undefined;
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 15_000,
    env: options.env,
    cwd: options.cwd,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  });
  if (result.error) return { ok: false, error: result.error, stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
  return { ok: result.status === 0, stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

function pythonInfo(command, prefix = []) {
  const probe = "import json,sys; print(json.dumps({'version':sys.version_info[:3],'executable':sys.executable}))";
  const result = runSync(command, [...prefix, "-c", probe]);
  if (!result.ok) return undefined;
  try {
    const parsed = JSON.parse(result.stdout.trim());
    const version = parsed.version;
    if (!Array.isArray(version) || version.length < 2) return undefined;
    return { command, prefix, version: { major: version[0], minor: version[1], patch: version[2] || 0 }, executable: parsed.executable };
  } catch {
    return undefined;
  }
}

export function findPython() {
  const configured = envPath("DSH_PYTHON") || envPath("PYTHON");
  const candidates = [];
  if (configured) candidates.push({ command: configured, prefix: [] });
  if (process.platform === "win32") {
    for (const minor of [12, 11, 10]) candidates.push({ command: "py", prefix: [`-3.${minor}`] });
  }
  candidates.push({ command: "python", prefix: [] }, { command: "python3", prefix: [] });
  let unsupported;
  for (const candidate of candidates) {
    const found = pythonInfo(candidate.command, candidate.prefix);
    if (!found) continue;
    const supported = found.version.major === 3 && found.version.minor >= 10 && found.version.minor <= 12;
    if (supported) return { ...found, supported: true };
    unsupported ||= { ...found, supported: false };
  }
  return unsupported;
}

export function getNodeInfo() {
  const version = parseVersion(process.versions.node);
  const supported = Boolean(version && (version.major > 22 || (version.major === 22 && version.minor >= 19)));
  return { version, supported, executable: process.execPath };
}

function commandVersion(command, args = ["--version"]) {
  const result = runSync(command, args, { timeout: 5_000 });
  return result.ok ? result.stdout.trim() : undefined;
}

function findPnpm() {
  const candidates = [envPath("PNPM_HOME") ? path.join(envPath("PNPM_HOME"), process.platform === "win32" ? "pnpm.cmd" : "pnpm") : undefined, "pnpm", "pnpm.cmd"].filter(Boolean);
  for (const candidate of candidates) {
    const version = commandVersion(candidate);
    if (version) return { command: candidate, version };
  }
  const harnessRuntime = envPath("HARNESS_RUNTIME_DIR");
  if (harnessRuntime) {
    const candidate = path.join(harnessRuntime, "pnpm", process.platform === "win32" ? "pnpm.cmd" : "pnpm");
    const version = commandVersion(candidate);
    if (version) return { command: candidate, version };
  }
  return undefined;
}

function diskSpace(pathname) {
  try {
    const stats = fs.statfsSync(pathname);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

function getVenvPython(paths) {
  return fs.existsSync(paths.venvPython) ? paths.venvPython : undefined;
}

export function inspectPythonPackage(python, packageName) {
  if (!python) return undefined;
  const probe = "import importlib.metadata as m, json, sys; n=sys.argv[1];\ntry: print(json.dumps({'version':m.version(n)}))\nexcept m.PackageNotFoundError: print(json.dumps({'version':None}))";
  const result = runSync(python, ["-c", probe, packageName], { timeout: 10_000 });
  if (!result.ok) return undefined;
  try {
    return JSON.parse(result.stdout.trim()).version || undefined;
  } catch {
    return undefined;
  }
}

export function inspectPaddle(python) {
  if (!python) return undefined;
  const probe = "import json; out={};\ntry:\n import paddle; out.update(paddle= getattr(paddle,'__version__',None), cuda=bool(paddle.is_compiled_with_cuda()), gpu_count=int(paddle.device.cuda.device_count()) if paddle.is_compiled_with_cuda() else 0)\nexcept Exception as e: out['error']=type(e).__name__\nprint(json.dumps(out))";
  const result = runSync(python, ["-c", probe], { timeout: 15_000 });
  if (!result.ok) return undefined;
  try { return JSON.parse(result.stdout.trim()); } catch { return undefined; }
}

function listHasModelFiles(cacheDir) {
  const pending = [cacheDir];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".keep" || entry.name === ".gitkeep") continue;
      const child = path.join(current, entry.name);
      if (entry.isFile()) return true;
      if (entry.isDirectory()) {
        pending.push(child);
        continue;
      }
      // Follow a file symlink when a package manager or model cache uses one,
      // but never follow directory symlinks recursively.
      if (entry.isSymbolicLink()) {
        try {
          if (fs.statSync(child).isFile()) return true;
        } catch {
          // A broken link is not a usable model artifact.
        }
      }
    }
  }
  return false;
}

export function modelStatus(paths, config = {}) {
  const consent = fs.existsSync(paths.consentFile);
  const cacheExists = fs.existsSync(paths.modelCacheDir);
  const hasArtifacts = listHasModelFiles(paths.modelCacheDir);
  const status = !consent ? "consent_required" : hasArtifacts ? "ready" : "not_downloaded";
  return {
    status,
    ready: status === "ready",
    consent,
    cacheExists,
    cacheDir: paths.modelCacheDir,
    artifactsPresent: hasArtifacts,
    provider: "PaddleOCR",
    version: config.paddleocrVersion || "3.7.0",
    paddleVersion: config.paddleVersion || "3.3.1",
    model: config.modelName || "PP-OCRv6 medium det/rec + textline orientation",
    language: config.language || envPath("OCR_LANGUAGE") || "ch",
    estimatedSize: "~140 MB for the verified Chinese CPU model (varies by language/backend)",
    downloadUrl: "https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/OCR.html",
  };
}

function applyConfigPaths(paths, config, options = {}) {
  if (!options.modelCacheDir && config?.modelCacheDir) {
    paths.modelCacheDir = path.resolve(config.modelCacheDir);
  }
  if (!options.url && !options.port && config?.serviceUrl) {
    const service = parseServiceUrl(config.serviceUrl, config.port || paths.port);
    paths.serviceUrl = service.url;
    paths.port = service.port;
  }
  return paths;
}

export async function askModelConsent(model, { yes = false, input = process.stdin, output = process.stdout } = {}) {
  output.write(`\nPaddleOCR model download\n  source: ${model.downloadUrl}\n  version: ${model.version}\n  language: ${model.language}\n  estimated size: ${model.estimatedSize}\n  cache: ${model.cacheDir}\n  privacy: model files are downloaded to this machine; images remain local.\n`);
  if (yes) return true;
  if (!input.isTTY || !output.isTTY) {
    throw new RuntimeError(
      "MODEL_DOWNLOAD_CONSENT_REQUIRED",
      "Model download consent is required. Re-run setup interactively or pass --yes after reviewing the source and cache path.",
      { exitCode: EXIT_CODES.MODEL_CONSENT_REQUIRED, fix: "npx dsh-local-ocr-runtime setup --yes" },
    );
  }
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question("Download these models now? [y/N] ");
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new RuntimeError(
        "MODEL_DOWNLOAD_CONSENT_REQUIRED",
        "Model download was declined; setup is incomplete and no service was started.",
        { exitCode: EXIT_CODES.MODEL_CONSENT_REQUIRED, fix: "Run npx dsh-local-ocr-runtime setup --yes when ready." },
      );
    }
  } finally {
    readline.close();
  }
  return true;
}

async function runAsync(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio || "inherit",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (chunk) => { stdout += chunk; });
    if (child.stderr) child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = options.timeout ? setTimeout(() => {
      child.kill();
      reject(new RuntimeError("COMMAND_TIMEOUT", `${command} timed out.`, { exitCode: EXIT_CODES.DEPENDENCY_ERROR }));
    }, options.timeout) : undefined;
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}

async function installDependencies(paths, python, { skipDependencies = false } = {}) {
  if (skipDependencies || process.env.DSH_RUNTIME_SKIP_INSTALL === "1") return { skipped: true };
  const target = paths.serviceDir ? `${paths.serviceDir}[ocr,test]` : "deepseek-harness-local-ocr-service[ocr,test]";
  const pythonArgs = python.executable ? [] : (python.prefix || []);
  const constraints = paths.serviceDir ? path.join(paths.serviceDir, "constraints.txt") : undefined;
  const result = await runAsync(python.executable || python.command, [...pythonArgs, "-m", "pip", "install", "--upgrade", "pip"], { timeout: 15 * 60_000 });
  if (result.code !== 0) {
    throw new RuntimeError("RUNTIME_DEPENDENCY_INSTALL_FAILED", `Could not upgrade pip.\n${result.stderr || result.stdout}`, {
      exitCode: EXIT_CODES.DEPENDENCY_ERROR,
      fix: "Check network access and Python 3.10-3.12, then rerun setup.",
    });
  }
  const installArgs = [...pythonArgs, "-m", "pip", "install", "--upgrade"];
  if (constraints && fs.existsSync(constraints)) installArgs.push("-c", constraints);
  if (paths.serviceDir) installArgs.push("-e");
  installArgs.push(target);
  const install = await runAsync(python.executable || python.command, installArgs, {
    cwd: paths.serviceDir || paths.stateDir,
    timeout: 45 * 60_000,
  });
  if (install.code !== 0) {
    throw new RuntimeError("RUNTIME_DEPENDENCY_INSTALL_FAILED", `Could not install OCR service dependencies.\n${install.stderr || install.stdout}`, {
      exitCode: EXIT_CODES.DEPENDENCY_ERROR,
      fix: "Check pip/network access, or pass --skip-dependencies when dependencies are already installed.",
    });
  }
  return { skipped: false };
}

async function createVenv(paths, python) {
  if (fs.existsSync(paths.venvPython)) return false;
  await fsp.mkdir(paths.stateDir, { recursive: true });
  const result = await runAsync(python.command, [...python.prefix, "-m", "venv", paths.venvDir], { timeout: 5 * 60_000 });
  if (result.code !== 0 || !fs.existsSync(paths.venvPython)) {
    throw new RuntimeError("RUNTIME_VENV_CREATE_FAILED", "Could not create the isolated OCR virtual environment.", {
      exitCode: EXIT_CODES.DEPENDENCY_ERROR,
      fix: "Check write permissions for the runtime state directory and rerun setup.",
      details: { stderr: result.stderr, stdout: result.stdout },
    });
  }
  return true;
}

async function prefetchModels(paths, config, { skipModelDownload = false } = {}) {
  if (skipModelDownload || process.env.DSH_RUNTIME_SKIP_MODEL_DOWNLOAD === "1") return { skipped: true };
  const python = paths.venvPython;
  const script = [
    "import inspect, os",
    `os.environ['PADDLE_PDX_CACHE_HOME'] = ${JSON.stringify(paths.modelCacheDir)}`,
    "from paddleocr import PaddleOCR",
    `kwargs = {'lang': ${JSON.stringify(config.language)}, 'device': ${JSON.stringify(config.useGpu ? "gpu:0" : "cpu")}, 'use_doc_orientation_classify': False, 'use_doc_unwarping': False, 'use_textline_orientation': True}`,
    "try:",
    "  params=inspect.signature(PaddleOCR).parameters",
    "  if params and not any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()): kwargs={k:v for k,v in kwargs.items() if k in params}",
    "except Exception: pass",
    "PaddleOCR(**kwargs)",
  ].join("\n");
  const result = await runAsync(python, ["-c", script], { env: { ...process.env, PADDLE_PDX_CACHE_HOME: paths.modelCacheDir }, timeout: 60 * 60_000 });
  if (result.code !== 0 || !listHasModelFiles(paths.modelCacheDir)) {
    throw new RuntimeError("MODEL_DOWNLOAD_FAILED", `PaddleOCR model download failed or produced no cache artifacts.\n${result.stderr || result.stdout}`, {
      exitCode: EXIT_CODES.MODEL_NOT_READY,
      fix: "Check network access and disk space, then rerun dsh-local-ocr-runtime setup --yes.",
    });
  }
  return { skipped: false };
}

export async function setup(options = {}) {
  const paths = getPaths(options);
  const node = getNodeInfo();
  if (!node.supported) {
    throw new RuntimeError("NODE_VERSION_UNSUPPORTED", `Node.js ${process.versions.node} is below the supported 22.19.0.`, {
      exitCode: EXIT_CODES.VERSION_MISMATCH,
      fix: "Install Node.js 22.19+ (or 24+) and rerun dsh-local-ocr-runtime setup.",
    });
  }
  const python = findPython();
  if (!python) {
    throw new RuntimeError("PYTHON_NOT_FOUND", "Python 3.10, 3.11, or 3.12 was not found.", {
      exitCode: EXIT_CODES.RUNTIME_NOT_INSTALLED,
      fix: "Install 64-bit Python 3.10-3.12, then rerun npx dsh-local-ocr-runtime setup.",
    });
  }
  if (!python.supported) {
    throw new RuntimeError("PYTHON_VERSION_UNSUPPORTED", `Python ${python.version.major}.${python.version.minor} is outside the supported 3.10-3.12 range.`, {
      exitCode: EXIT_CODES.VERSION_MISMATCH,
      fix: "Install Python 3.10, 3.11, or 3.12 and set DSH_PYTHON to its executable.",
    });
  }
  await ensureDirectories(paths);
  const config = {
    runtimeVersion: RUNTIME_VERSION,
    python: python.version,
    language: options.language || envPath("OCR_LANGUAGE") || "ch",
    useGpu: Boolean(options.gpu || (options.cpu !== true && envPath("OCR_USE_GPU") === "true")),
    paddleocrVersion: "3.7.0",
    paddleVersion: "3.3.1",
    modelName: "PP-OCRv6 medium det/rec + textline orientation",
    port: paths.port,
    serviceUrl: paths.serviceUrl,
    modelCacheDir: paths.modelCacheDir,
    serviceDir: paths.serviceDir,
    setupStatus: "in_progress",
    updatedAt: new Date().toISOString(),
  };
  await writeConfig(paths, config);
  try {
    await createVenv(paths, python);
    await installDependencies(paths, { executable: paths.venvPython, prefix: [] }, options);
    const model = modelStatus(paths, config);
    const existingConsent = await readConsent(paths);
    if (!existingConsent) await askModelConsent(model, options);
    await fsp.writeFile(paths.consentFile, `${JSON.stringify({
      consentedAt: new Date().toISOString(),
      source: model.downloadUrl,
      version: model.version,
      language: model.language,
      cacheDir: model.cacheDir,
    }, null, 2)}\n`, "utf8");
    await prefetchModels(paths, config, options);
    config.setupStatus = "ready";
    config.model = modelStatus(paths, config);
    config.updatedAt = new Date().toISOString();
    await writeConfig(paths, config);
    return { paths, config, model: config.model };
  } catch (error) {
    config.setupStatus = "failed";
    config.lastError = { code: error.code || "SETUP_FAILED", message: error.message };
    config.updatedAt = new Date().toISOString();
    await writeConfig(paths, config);
    throw error;
  }
}

export function processCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  if (process.platform === "linux") {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim(); } catch { return ""; }
  }
  if (process.platform === "darwin") {
    const result = runSync("ps", ["-p", String(pid), "-o", "command="], { timeout: 5_000 });
    return result.ok ? result.stdout.trim() : "";
  }
  const script = `$p=Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; if ($p) { $p.CommandLine }`;
  const result = runSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { timeout: 5_000 });
  return result.ok ? result.stdout.trim() : "";
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export function ownsProcess(state, paths) {
  if (!state || !isProcessAlive(state.pid)) return false;
  const command = processCommandLine(state.pid);
  if (!command) return false;
  const expectedPort = String(paths.port);
  return command.includes("local_ocr_service.app:app") && (command.includes(`--port ${expectedPort}`) || command.includes(`--port=${expectedPort}`));
}

async function fetchHealth(paths, timeoutMs = 1_500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${paths.serviceUrl}/health`, { signal: controller.signal, headers: authHeaders() });
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, error };
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders() {
  const token = envPath("OCR_SERVICE_TOKEN");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function triggerWarmup(paths, timeoutMs = 15_000) {
  const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const form = new FormData();
  form.append("file", new Blob([onePixelPng], { type: "image/png" }), "runtime-warmup.png");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${paths.serviceUrl}/v1/ocr`, { method: "POST", body: form, headers: authHeaders(), signal: controller.signal });
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, error };
  } finally { clearTimeout(timer); }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function acquireStartLock(paths) {
  await fsp.mkdir(paths.stateDir, { recursive: true });
  const lockFile = path.join(paths.stateDir, "start.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(lockFile, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
      await handle.close();
      return async () => {
        try { await fsp.unlink(lockFile); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let lock;
      try { lock = JSON.parse(await fsp.readFile(lockFile, "utf8")); } catch { lock = undefined; }
      if (lock?.pid && isProcessAlive(lock.pid)) {
        throw new RuntimeError("OCR_RUNTIME_START_IN_PROGRESS", "Another dsh-local-ocr-runtime start command is already running.", {
          exitCode: EXIT_CODES.PROCESS_CONFLICT,
          fix: "Wait for the first start command to finish, then run status.",
        });
      }
      try { await fsp.unlink(lockFile); } catch (unlinkError) { if (unlinkError?.code !== "ENOENT") throw unlinkError; }
    }
  }
  throw new RuntimeError("OCR_RUNTIME_START_IN_PROGRESS", "Could not acquire the runtime start lock.", {
    exitCode: EXIT_CODES.PROCESS_CONFLICT,
    fix: "Run dsh-local-ocr-runtime status and retry start.",
  });
}

export async function start(options = {}) {
  const paths = getPaths(options);
  const config = await readConfig(paths);
  if (!config || config.setupStatus !== "ready") {
    throw new RuntimeError("OCR_RUNTIME_NOT_INSTALLED", "The local OCR runtime is not set up.", {
      exitCode: EXIT_CODES.RUNTIME_NOT_INSTALLED,
      fix: "Run npx dsh-local-ocr-runtime setup --yes.",
    });
  }
  applyConfigPaths(paths, config, options);
  const model = modelStatus(paths, config);
  if (!model.consent || !model.ready) {
    throw new RuntimeError("OCR_MODEL_NOT_READY", model.consent ? "PaddleOCR model files have not been downloaded." : "Model download consent has not been recorded.", {
      exitCode: EXIT_CODES.MODEL_NOT_READY,
      fix: model.consent ? "Run npx dsh-local-ocr-runtime setup --yes to download the model cache." : "Run npx dsh-local-ocr-runtime setup --yes.",
    });
  }
  const releaseStartLock = await acquireStartLock(paths);
  let state;
  try {
    const existing = await readState(paths);
    if (existing?.pid && isProcessAlive(existing.pid)) {
      if (!ownsProcess(existing, paths)) {
        throw new RuntimeError("OCR_RUNTIME_PROCESS_CONFLICT", `Port ${paths.port} is owned by a process not created by this runtime.`, {
          exitCode: EXIT_CODES.PROCESS_CONFLICT,
          fix: `Stop the process using port ${paths.port} yourself, then rerun dsh-local-ocr-runtime start.`,
        });
      }
      const health = await fetchHealth(paths);
      if (health.body?.ready) return { state: "running", alreadyRunning: true, health: health.body, paths };
      return { state: "starting", alreadyRunning: true, health: health.body, paths };
    }
    if (existing) await clearState(paths);
    const python = getVenvPython(paths);
    if (!python) {
      throw new RuntimeError("OCR_RUNTIME_NOT_INSTALLED", "The runtime virtual environment is missing.", {
        exitCode: EXIT_CODES.RUNTIME_NOT_INSTALLED,
        fix: "Run npx dsh-local-ocr-runtime setup --yes.",
      });
    }
    const portProbe = await isPortFree(paths.port);
    if (!portProbe) {
      throw new RuntimeError("OCR_RUNTIME_PROCESS_CONFLICT", `Port ${paths.port} is already in use.`, {
        exitCode: EXIT_CODES.PROCESS_CONFLICT,
        fix: `Set OCR_SERVICE_URL=http://127.0.0.1:<free-port> and rerun start.`,
      });
    }
    const args = ["-m", "uvicorn", "local_ocr_service.app:app"];
    if (paths.appDir) args.push("--app-dir", paths.appDir);
    args.push("--host", "127.0.0.1", "--port", String(paths.port));
    const logFd = fs.openSync(paths.logFile, "a");
    const ownerToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const env = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      OCR_SERVICE_URL: paths.serviceUrl,
      OCR_MODEL_CACHE_DIR: paths.modelCacheDir,
      OCR_USE_GPU: config.useGpu ? "true" : "false",
      OCR_LANGUAGE: config.language,
      DSH_LOCAL_OCR_RUNTIME_OWNER: ownerToken,
    };
    let child;
    try {
      child = spawn(python, args, { cwd: paths.serviceDir || paths.stateDir, env, detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd] });
      child.unref();
    } catch (error) {
      fs.closeSync(logFd);
      throw new RuntimeError("OCR_RUNTIME_START_FAILED", `Could not launch the OCR service: ${error.message}`, {
        exitCode: EXIT_CODES.SERVICE_START_ERROR,
        fix: "Run dsh-local-ocr-runtime doctor and inspect the runtime log.",
      });
    }
    fs.closeSync(logFd);
    state = { pid: child.pid, ownerToken, startedAt: new Date().toISOString(), serviceUrl: paths.serviceUrl, port: paths.port, command: args.join(" "), readyAt: null };
    await writeState(paths, state);
  } finally {
    await releaseStartLock();
  }
  const deadline = Date.now() + (options.timeoutMs || 120_000);
  let warmed = false;
  try {
    while (Date.now() < deadline) {
      const health = await fetchHealth(paths, 2_000);
      if (health.body?.ready) {
        state.readyAt = new Date().toISOString();
        await writeState(paths, state);
        return { state: "running", health: health.body, paths };
      }
      if (health.ok && !warmed) {
        warmed = true;
        const warmup = await triggerWarmup(paths, Math.min(30_000, Math.max(5_000, deadline - Date.now())));
        if (!warmup.ok && ["ENGINE_UNAVAILABLE", "OCR_ENGINE_UNAVAILABLE", "OCR_MODEL_NOT_READY"].includes(warmup.body?.error?.code)) {
          throw new RuntimeError("OCR_MODEL_NOT_READY", "The OCR service could not initialize PaddleOCR models.", {
            exitCode: EXIT_CODES.MODEL_NOT_READY,
            fix: "Run dsh-local-ocr-runtime doctor, check the model cache and rerun setup --yes.",
            details: { response: warmup.body },
          });
        }
      }
      await sleep(500);
    }
    throw new RuntimeError("OCR_MODEL_NOT_READY", "The OCR service did not report a ready model before the startup timeout.", {
      exitCode: EXIT_CODES.MODEL_NOT_READY,
      fix: "Run dsh-local-ocr-runtime doctor and inspect the runtime log before retrying start.",
    });
  } catch (error) {
    if (ownsProcess(state, paths)) await terminateProcess(state.pid);
    await clearState(paths);
    throw error;
  }
}

export async function terminateProcess(pid) {
  if (!isProcessAlive(pid)) return;
  if (process.platform === "win32") {
    const result = runSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 10_000 });
    if (!result.ok && isProcessAlive(pid)) throw new Error(result.stderr || `taskkill failed for PID ${pid}`);
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  const deadline = Date.now() + 5_000;
  while (isProcessAlive(pid) && Date.now() < deadline) await sleep(100);
  if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
}

export async function stop(options = {}) {
  const paths = getPaths(options);
  const config = await readConfig(paths);
  applyConfigPaths(paths, config, options);
  const state = await readState(paths);
  if (!state?.pid || !isProcessAlive(state.pid)) {
    if (state) await clearState(paths);
    return { state: "stopped", alreadyStopped: true, paths };
  }
  if (!ownsProcess(state, paths)) {
    throw new RuntimeError("OCR_RUNTIME_PROCESS_CONFLICT", "Refusing to stop a process that this runtime did not create.", {
      exitCode: EXIT_CODES.PROCESS_CONFLICT,
      fix: "Inspect the recorded PID and stop the unrelated process manually; runtime state was left untouched.",
    });
  }
  await terminateProcess(state.pid);
  await clearState(paths);
  return { state: "stopped", pid: state.pid, paths };
}

export async function status(options = {}) {
  const paths = getPaths(options);
  const config = await readConfig(paths);
  applyConfigPaths(paths, config, options);
  const state = await readState(paths);
  if (!config || config.setupStatus !== "ready") {
    return { state: "not_installed", code: "OCR_RUNTIME_NOT_INSTALLED", paths, setupStatus: config?.setupStatus };
  }
  const model = modelStatus(paths, config);
  const processAlive = Boolean(state?.pid && isProcessAlive(state.pid));
  if (!processAlive) {
    if (!model.ready) return { state: "model_not_ready", code: "OCR_MODEL_NOT_READY", paths, model };
    return { state: "stopped", code: "OCR_RUNTIME_NOT_RUNNING", paths, model };
  }
  if (!ownsProcess(state, paths)) return { state: "conflict", code: "OCR_RUNTIME_PROCESS_CONFLICT", pid: state.pid, paths };
  const health = await fetchHealth(paths);
  if (!health.ok) return { state: "starting", code: "OCR_RUNTIME_STARTING", pid: state.pid, paths, health };
  if (!health.body?.ready) return { state: "model_not_ready", code: "OCR_MODEL_NOT_READY", pid: state.pid, paths, health };
  return { state: "running", code: "OK", pid: state.pid, paths, health: health.body, model };
}

export async function isPortFree(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolve(true)));
  });
}

const LEGACY_BRIDGE_DEFAULT_PATTERN = /(?:^|\r?\n)\s*-\s*id:\s*agent-default-model\s*\r?\n\s+config:\s*\r?\n\s+provider:\s*deepseek-local-ocr\s*\r?\n\s+model:\s*deepseek-v4-flash\s*(?=\r?\n|$)/m;

function inspectLegacyBridgeDefault(profileDir) {
  const patchPath = path.join(profileDir, "cordis.patch.yml");
  let contents;
  try {
    contents = fs.readFileSync(patchPath, "utf8");
  } catch {
    return { path: patchPath, present: false };
  }
  return { path: patchPath, present: LEGACY_BRIDGE_DEFAULT_PATTERN.test(contents) };
}

export async function doctor(options = {}) {
  const paths = getPaths(options);
  const config = await readConfig(paths);
  applyConfigPaths(paths, config, options);
  const state = await readState(paths);
  const checks = [];
  const add = (name, ok, message, extra = {}) => checks.push({ name, status: ok ? "ok" : (extra.warning ? "warning" : "error"), message, ...extra });
  const runtimeConfigMatches = !config || !config.runtimeVersion || config.runtimeVersion === RUNTIME_VERSION;
  add("runtime_version", runtimeConfigMatches, runtimeConfigMatches ? `Runtime state schema is compatible with ${RUNTIME_VERSION}` : `Runtime state was created by ${config.runtimeVersion}, but this CLI is ${RUNTIME_VERSION}`, { code: "OCR_VERSION_MISMATCH", fix: "Run dsh-local-ocr-runtime setup --yes to migrate the runtime state." });
  const node = getNodeInfo();
  add("node", node.supported, node.supported ? `Node.js ${process.versions.node}` : `Node.js ${process.versions.node} is below the supported 22.19.0`, { fix: "Install Node.js 22.19+ before publishing or using the runtime." });
  const pnpm = findPnpm();
  add("pnpm", Boolean(pnpm), pnpm ? `pnpm ${pnpm.version}` : "pnpm was not found (required to install the Harness plugin)", { warning: true, fix: "Install pnpm 11 or set HARNESS_RUNTIME_DIR to a Harness runtime directory." });
  const python = findPython();
  add("python", Boolean(python?.supported), python ? `Python ${python.version.major}.${python.version.minor}.${python.version.patch} (${python.executable})` : "Python 3.10-3.12 was not found", { fix: "Install Python 3.10, 3.11, or 3.12 and set DSH_PYTHON if needed.", details: python });
  const venvPython = getVenvPython(paths);
  add("venv", Boolean(venvPython), venvPython ? `Isolated virtual environment: ${paths.venvDir}` : "Runtime virtual environment is missing", { fix: "Run npx dsh-local-ocr-runtime setup --yes." });
  const paddleocr = inspectPythonPackage(venvPython, "paddleocr");
  const paddle = inspectPythonPackage(venvPython, "paddlepaddle");
  const servicePackage = inspectPythonPackage(venvPython, "deepseek-harness-local-ocr-service");
  const expectedPaddleocr = config?.paddleocrVersion || config?.model?.version || "3.7.0";
  const expectedPaddle = config?.paddleVersion || "3.3.1";
  const dependencyVersionsMatch = Boolean(paddleocr && paddle && paddleocr === expectedPaddleocr && paddle === expectedPaddle);
  add("dependencies", Boolean(paddleocr && paddle && servicePackage && dependencyVersionsMatch), paddleocr && paddle && servicePackage ? `OCR service ${servicePackage}; PaddleOCR ${paddleocr}; PaddlePaddle ${paddle}` : "OCR service, PaddleOCR or PaddlePaddle is missing from the runtime venv", { code: paddleocr && paddle && !dependencyVersionsMatch ? "OCR_VERSION_MISMATCH" : undefined, fix: "Run npx dsh-local-ocr-runtime setup --yes to install the locked Python versions.", details: { service: servicePackage, paddleocr, paddle, expectedPaddleocr, expectedPaddle } });
  const model = modelStatus(paths, config || {});
  add("model", model.ready, model.ready ? `Model cache is ready at ${model.cacheDir}` : model.consent ? `Model files are not downloaded at ${model.cacheDir}` : "Model download consent has not been recorded", { code: "OCR_MODEL_NOT_READY", fix: "Run npx dsh-local-ocr-runtime setup --yes.", details: model });
  const device = inspectPaddle(venvPython);
  const wantsGpu = Boolean(config?.useGpu || envPath("OCR_USE_GPU") === "true");
  add("device", !wantsGpu || Boolean(device?.cuda && device.gpu_count > 0), wantsGpu ? (device?.cuda ? `GPU requested; Paddle reports ${device.gpu_count} CUDA device(s)` : "GPU requested but no Paddle CUDA device is available") : "CPU mode configured", { warning: !wantsGpu && false, fix: wantsGpu ? "Use --cpu or install a compatible Paddle GPU build and driver." : undefined, details: device });
  const availableBytes = diskSpace(paths.stateDir) ?? diskSpace(os.tmpdir());
  add("disk", availableBytes === undefined || availableBytes >= 5 * 1024 ** 3, availableBytes === undefined ? "Could not inspect free disk space" : `${Math.round(availableBytes / 1024 ** 3)} GB free for the runtime and models`, { warning: availableBytes === undefined || availableBytes >= 5 * 1024 ** 3, fix: "Keep at least 5 GB free for the isolated venv and PaddleOCR models.", details: { availableBytes } });
  const portFree = await isPortFree(paths.port);
  const owned = state?.pid && ownsProcess(state, paths);
  const serviceHealthy = state?.pid && isProcessAlive(state.pid) ? await fetchHealth(paths) : undefined;
  add("port", Boolean(!state?.pid ? portFree : owned && serviceHealthy?.status), !state?.pid ? (portFree ? `127.0.0.1:${paths.port} is available` : `127.0.0.1:${paths.port} is occupied`) : (owned && serviceHealthy?.ok ? `OCR service responded on ${paths.serviceUrl}` : "Recorded OCR service process is not reachable or is not owned by this runtime"), { fix: "Stop the conflicting process or choose another OCR_SERVICE_URL port." });
  add("binding", new URL(paths.serviceUrl).hostname === "127.0.0.1", `Service URL is ${paths.serviceUrl}`, { fix: "Use a loopback-only http://127.0.0.1:<port> URL." });
  const dshHome = path.resolve(envPath("DSH_HOME") || (process.platform === "win32" ? "D:\\.dsh" : path.join(os.homedir(), ".dsh")));
  const profile = options.profile || envPath("DSH_PROFILE") || "local-ocr";
  const profileDir = path.join(dshHome, "profiles", profile);
  const legacyBridgeDefault = inspectLegacyBridgeDefault(profileDir);
  add(
    "model_selection",
    !legacyBridgeDefault.present,
    legacyBridgeDefault.present
      ? `Profile '${profile}' still contains the V2 preview forced local OCR model selection`
      : "Profile does not contain the V2 preview forced model selection",
    {
      warning: legacyBridgeDefault.present,
      code: legacyBridgeDefault.present ? "OCR_LEGACY_DEFAULT_MODEL" : undefined,
      fix: legacyBridgeDefault.present
        ? `Run .\\scripts\\install-plugin.ps1 -Profile ${profile} -DshHome "${dshHome}" from the project checkout, then restart Harness.`
        : undefined,
      details: legacyBridgeDefault,
    },
  );
  const profileManifest = path.join(profileDir, "package.json");
  let profileData;
  try { profileData = JSON.parse(fs.readFileSync(profileManifest, "utf8")); } catch { profileData = undefined; }
  const bundles = profileData?.dsh?.profile?.bundles || [];
  const pluginLocations = [
    path.join(profileDir, "plugins", "dsh-plugin-local-ocr"),
    path.join(profileDir, "node_modules", "dsh-plugin-local-ocr"),
  ];
  const pluginPath = pluginLocations.find((candidate) => fs.existsSync(candidate));
  const pluginManifest = pluginPath ? path.join(pluginPath, "package.json") : undefined;
  let pluginData;
  try { pluginData = pluginManifest ? JSON.parse(fs.readFileSync(pluginManifest, "utf8")) : undefined; } catch { pluginData = undefined; }
  const pluginBundlePresent = bundles.includes("dsh-plugin-local-ocr");
  const pluginPresent = fs.existsSync(profileManifest) && Boolean(pluginPath) && pluginBundlePresent;
  add("dsh_profile", pluginPresent, pluginPresent ? `Profile '${profile}' includes dsh-plugin-local-ocr${pluginData?.version ? ` ${pluginData.version}` : ""}` : `Profile '${profile}' or its local OCR plugin is missing`, { warning: true, fix: `npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile ${profile} add dsh-plugin-local-ocr`, details: { dshHome, profile, profileManifest, bundles, pluginBundlePresent, pluginPath, pluginVersion: pluginData?.version } });
  const webBundlePresent = bundles.includes("@deepseek-ai/dsh-web-app");
  add("dsh_web_bundle", webBundlePresent, webBundlePresent ? `Profile '${profile}' includes the Harness Web bundle` : `Profile '${profile}' is missing @deepseek-ai/dsh-web-app, so it cannot serve the browser UI`, { warning: true, fix: `npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile ${profile} add @deepseek-ai/dsh-web-app@0.1.0-rc.6`, details: { dshHome, profile, profileManifest, bundles } });
  const stale = Boolean(state?.pid && !isProcessAlive(state.pid));
  const processConflict = Boolean(state?.pid && isProcessAlive(state.pid) && !owned);
  add("process", !stale && !processConflict, stale ? `Stale PID ${state.pid} remains in runtime state` : processConflict ? `Recorded PID ${state.pid} is alive but does not match this runtime's OCR command` : state?.pid ? `Runtime owns PID ${state.pid}` : "No runtime process is recorded", { warning: stale, code: processConflict ? "OCR_RUNTIME_PROCESS_CONFLICT" : undefined, fix: "Run dsh-local-ocr-runtime stop, then start again." });
  const errors = checks.filter((check) => check.status === "error");
  return {
    runtime: { version: RUNTIME_VERSION, installPath: moduleRoot, stateDir: paths.stateDir },
    paths,
    checks,
    ok: errors.length === 0,
    errors: errors.length,
    generatedAt: new Date().toISOString(),
  };
}
