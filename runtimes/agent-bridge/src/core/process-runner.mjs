import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";

const HOME = os.homedir();

const EXTRA_SEARCH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(HOME, ".local", "bin"),
  path.join(HOME, ".claude", "local"),
  path.join(HOME, ".npm-global", "bin"),
  path.join(HOME, ".cargo", "bin"),
  "/Applications/Antigravity.app/Contents/Resources/app/bin",
  "/Applications/Claude.app/Contents/MacOS",
];

/**
 * Resolve an executable binary from an explicit environment variable, PATH, or common install directories.
 * @param {string} binaryName - e.g. 'codex', 'claude', 'agy'
 * @param {string} [envVarName] - e.g. 'CODEX_BIN', 'CLAUDE_BIN', 'AGY_BIN'
 * @returns {string | null}
 */
export function resolveBinary(binaryName, envVarName) {
  if (envVarName && process.env[envVarName]) {
    const customPath = process.env[envVarName];
    return isExecutable(customPath) ? customPath : null;
  }

  const pathDirs = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  const allDirs = [...new Set([...pathDirs, ...EXTRA_SEARCH_DIRS])];

  for (const dir of allDirs) {
    const candidate = path.join(dir, binaryName);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build an enriched PATH environment variable including standard Homebrew/local user bin directories.
 */
export function buildEnrichedEnv(extraEnv = {}) {
  const existingPath = process.env.PATH || "";
  const mergedDirs = [
    ...new Set([
      ...existingPath.split(path.delimiter).filter(Boolean),
      ...EXTRA_SEARCH_DIRS,
    ]),
  ];
  return {
    ...process.env,
    ...extraEnv,
    PATH: mergedDirs.join(path.delimiter),
  };
}

/**
 * Run a CLI command asynchronously and capture stdout, stderr, exitCode, and duration.
 *
 * @param {object} options
 * @param {string} options.command - Executable path or name
 * @param {string[]} [options.args] - Command arguments
 * @param {string} [options.cwd] - Working directory
 * @param {string} [options.stdinText] - Optional text to write to stdin
 * @param {number} [options.timeoutMs] - Timeout in milliseconds; 0 disables the deadline (default: 300000 = 5 min)
 * @param {Record<string, string>} [options.env] - Additional environment variables
 */
export async function runCommand({
  command,
  args = [],
  cwd = process.cwd(),
  stdinText = undefined,
  timeoutMs = 300_000,
  env = {},
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("timeoutMs must be a finite non-negative number");
  }
  const startTime = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let stdinError = null;

    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      env: buildEnrichedEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin.on("error", (err) => {
      stdinError = { code: err.code || "STDIN_WRITE_FAILED", message: err.message };
    });

    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2000);
    }, timeoutMs) : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: -1,
        timedOut: false,
        durationMs: Date.now() - startTime,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: err.message,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut && !stdinError,
        stdinError,
        ...(stdinError ? { error: `Input delivery failed: ${stdinError.message}` } : {}),
        exitCode: code ?? -1,
        timedOut,
        durationMs: Date.now() - startTime,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    if (stdinText !== undefined && stdinText !== null) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

/**
 * Parse JSON Lines (JSONL) output into an array of parsed event objects.
 * @param {string} stdout
 */
export function parseJsonLines(stdout) {
  const events = [];
  const rawLines = [];
  for (const line of (stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        events.push(JSON.parse(trimmed));
        continue;
      } catch {
        // Not valid JSON
      }
    }
    rawLines.push(trimmed);
  }
  return { events, rawLines };
}
