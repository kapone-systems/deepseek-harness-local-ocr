#!/usr/bin/env node
import { EXIT_CODES, RuntimeError, doctor, getPaths, setup, start, status, stop } from "./runtime.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "doctor";
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--cpu") options.cpu = true;
    else if (arg === "--gpu") options.gpu = true;
    else if (arg === "--skip-dependencies") options.skipDependencies = true;
    else if (arg === "--skip-model-download" || arg === "--defer-model") options.skipModelDownload = true;
    else if (arg === "--state-dir" || arg === "--model-cache-dir" || arg === "--service-dir" || arg === "--url" || arg === "--profile" || arg === "--language") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new RuntimeError("INVALID_ARGUMENTS", `${arg} requires a value.`, { exitCode: EXIT_CODES.INVALID_ARGUMENTS, fix: "Run with --help to see command options." });
      const key = { "--state-dir": "stateDir", "--model-cache-dir": "modelCacheDir", "--service-dir": "serviceDir", "--url": "url", "--profile": "profile", "--language": "language" }[arg];
      options[key] = value;
    } else if (arg === "--port" || arg === "--timeout") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value <= 0) throw new RuntimeError("INVALID_ARGUMENTS", `${arg} requires a positive integer.`, { exitCode: EXIT_CODES.INVALID_ARGUMENTS, fix: "Run with --help to see command options." });
      options[arg === "--port" ? "port" : "timeoutMs"] = arg === "--port" ? value : value * 1000;
    } else {
      throw new RuntimeError("INVALID_ARGUMENTS", `Unknown argument: ${arg}`, { exitCode: EXIT_CODES.INVALID_ARGUMENTS, fix: "Run dsh-local-ocr-runtime --help." });
    }
  }
  return { command, options };
}

function help() {
  return `dsh-local-ocr-runtime ${"0.2.0"}\n\nCommands:\n  doctor       Inspect Python, dependencies, models, profile, port and process state\n  setup        Create the isolated venv, install OCR dependencies and consent to model download\n  start        Start one loopback-only OCR service and wait until the model is ready\n  status       Report stopped, starting, model_not_ready or running\n  stop         Stop only the service process recorded and owned by this runtime\n\nOptions:\n  --yes                         Explicitly consent to downloading PaddleOCR models\n  --cpu / --gpu                Select inference device (CPU is the default)\n  --state-dir <path>           Override runtime state directory\n  --model-cache-dir <path>     Override model cache directory\n  --service-dir <path>         Use a local ocr-service source checkout\n  --url <loopback-url>         Set OCR service URL (default http://127.0.0.1:8765)\n  --port <number>              Set OCR service port\n  --skip-dependencies          Use an already provisioned venv (development/testing)\n  --skip-model-download        Record consent but defer model download\n  --json                       Print machine-readable output (doctor/status)\n  --help                       Show this message\n`;
}

function printResult(result, { json = false } = {}) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (result?.checks) {
    process.stdout.write(`Runtime ${result.runtime.version} at ${result.runtime.installPath}\n`);
    for (const check of result.checks) process.stdout.write(`${check.status === "ok" ? "OK" : check.status === "warning" ? "WARN" : "ERROR"} ${check.name}: ${check.message}\n`);
    if (!result.ok) process.stdout.write("Run the suggested fix for each ERROR, then run doctor again.\n");
    return;
  }
  if (result?.state) process.stdout.write(`OCR runtime: ${result.state}${result.pid ? ` (pid ${result.pid})` : ""}\n`);
  if (result?.paths) process.stdout.write(`Service: ${result.paths.serviceUrl}\n`);
  if (result?.model && !result.model.ready) process.stdout.write(`Model: ${result.model.status}; run setup --yes if needed.\n`);
  if (result?.config?.setupStatus === "ready") process.stdout.write(`Setup complete. Start with: npx dsh-local-ocr-runtime start\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs([...argv]);
  if (options.help || command === "help") {
    process.stdout.write(help());
    return EXIT_CODES.OK;
  }
  const action = { doctor, setup, start, status, stop }[command];
  if (!action) throw new RuntimeError("INVALID_ARGUMENTS", `Unknown command: ${command}`, { exitCode: EXIT_CODES.INVALID_ARGUMENTS, fix: "Run dsh-local-ocr-runtime --help." });
  const result = await action(options);
  printResult(result, options);
  if (command === "doctor" && !result.ok) return EXIT_CODES.RUNTIME_NOT_INSTALLED;
  if (command === "status" && ["not_installed", "model_not_ready", "conflict"].includes(result.state)) return EXIT_CODES[result.state === "not_installed" ? "RUNTIME_NOT_INSTALLED" : result.state === "model_not_ready" ? "MODEL_NOT_READY" : "PROCESS_CONFLICT"];
  return EXIT_CODES.OK;
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    const runtimeError = error instanceof RuntimeError ? error : new RuntimeError("RUNTIME_FAILED", error?.message || String(error), { exitCode: EXIT_CODES.CONFIGURATION });
    process.stderr.write(`${runtimeError.code}: ${runtimeError.message}\n`);
    if (runtimeError.fix) process.stderr.write(`Fix: ${runtimeError.fix}\n`);
    process.exitCode = runtimeError.exitCode;
  });
}
