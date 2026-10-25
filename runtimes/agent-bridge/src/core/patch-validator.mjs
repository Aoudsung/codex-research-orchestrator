import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./process-runner.mjs";

/**
 * Compute SHA-256 hex digest of exact string bytes.
 * @param {string} content
 */
export function sha256Hex(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Normalize a relative path and check if it stays within any of the allowed root prefixes.
 * Rejects absolute paths or '..' traversal outside roots.
 *
 * @param {string} filePath
 * @param {string[]} allowedRoots
 * @returns {{ allowed: boolean, normalizedPath: string, matchedRoot: string | null, reason?: string }}
 */
export function checkPathWithinRoots(filePath, allowedRoots = []) {
  if (!filePath || typeof filePath !== "string") {
    return {
      allowed: false,
      normalizedPath: "",
      matchedRoot: null,
      reason: "Empty or non-string file path",
    };
  }

  // Diff prefixes belong to the parser, not to real workspace paths.
  const trimmed = filePath;
  if (trimmed.includes("\\")) return { allowed: false, normalizedPath: trimmed, matchedRoot: null, reason: "Use project-relative POSIX paths" };

  if (path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
    return {
      allowed: false,
      normalizedPath: trimmed,
      matchedRoot: null,
      reason: `Absolute path '${trimmed}' is not allowed in relative workspace patch`,
    };
  }

  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    return {
      allowed: false,
      normalizedPath: normalized,
      matchedRoot: null,
      reason: `Path traversal detected in '${filePath}'`,
    };
  }

  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    return { allowed: false, normalizedPath: normalized, matchedRoot: null, reason: "No explicit write roots authorized" };
  }

  for (const root of allowedRoots) {
    const normRoot = path.posix
      .normalize(String(root))
      .replace(/\/+$/, "");
    if (normRoot === "." || normalized === normRoot || normalized.startsWith(`${normRoot}/`)) {
      return {
        allowed: true,
        normalizedPath: normalized,
        matchedRoot: normRoot,
      };
    }
  }

  return {
    allowed: false,
    normalizedPath: normalized,
    matchedRoot: null,
    reason: `Path '${normalized}' is outside authorized roots: [${allowedRoots.join(", ")}]`,
  };
}

/**
 * Parse and validate a unified diff string without modifying the author's original raw content.
 * Checks:
 * - Presence of diff headers and hunks
 * - Hunk line counts (`@@ -oldStart,oldCount +newStart,newCount @@`) vs actual lines
 * - Target file paths against authorized `writeRoots`
 * - Generates a `recountedContent` version if hunk line counts had minor header count discrepancies
 *
 * @param {string} rawDiff
 * @param {object} [options]
 * @param {string[]} [options.writeRoots]
 */
export function validateUnifiedDiff(rawDiff, { writeRoots = [] } = {}) {
  const errors = [];
  const warnings = [];
  const targetFiles = new Set();
  const hunks = [];

  if (typeof rawDiff !== "string" || rawDiff.trim().length === 0) {
    return {
      valid: false,
      hunkCountValid: false,
      pathScopeValid: false,
      targetFiles: [],
      hunkSummary: [],
      errors: ["Patch content is empty."],
      warnings: [],
      recountedContent: rawDiff,
    };
  }

  const lines = rawDiff.split(/\r?\n/);
  let currentFile = null;
  let currentHunk = null;

  const finishHunk = () => {
    if (!currentHunk) return;
    const oldMismatch = currentHunk.actualOldLines !== currentHunk.expectedOldLines;
    const newMismatch = currentHunk.actualNewLines !== currentHunk.expectedNewLines;
    currentHunk.countMatched = !oldMismatch && !newMismatch;

    if (!currentHunk.countMatched) {
      errors.push(
        `Hunk line count mismatch in ${currentHunk.file || "<unknown>"} at line ${currentHunk.headerLineNumber}: header declared -${currentHunk.oldStart},${currentHunk.expectedOldLines} +${currentHunk.newStart},${currentHunk.expectedNewLines}, but body actually has -${currentHunk.actualOldLines} / +${currentHunk.actualNewLines} lines.`
      );
    }
    hunks.push(currentHunk);
    currentHunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      finishHunk();
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) {
        currentFile = m[2];
        targetFiles.add(m[1]);
        targetFiles.add(m[2]);
      } else {
        errors.push("Unsupported diff path header");
      }
      continue;
    }

    const movedPath = line.match(/^(?:rename|copy) (?:from|to) (.+)$/);
    if (movedPath) {
      targetFiles.add(movedPath[1]);
      continue;
    }

    if (line.startsWith("--- ")) {
      finishHunk();
      const rawPath = line.slice(4).split("\t")[0];
      if (rawPath !== "/dev/null") {
        const clean = rawPath.replace(/^a\//, "");
        targetFiles.add(clean);
        currentFile = clean;
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      finishHunk();
      const rawPath = line.slice(4).split("\t")[0];
      if (rawPath !== "/dev/null") {
        const clean = rawPath.replace(/^b\//, "");
        targetFiles.add(clean);
        currentFile = clean;
      }
      continue;
    }

    const hunkMatch = line.match(
      /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/
    );
    if (hunkMatch) {
      finishHunk();
      currentHunk = {
        file: currentFile,
        headerLineIndex: i,
        headerLineNumber: i + 1,
        oldStart: parseInt(hunkMatch[1], 10),
        expectedOldLines: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        expectedNewLines: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
        trailingHeader: hunkMatch[5] || "",
        actualOldLines: 0,
        actualNewLines: 0,
        countMatched: true,
      };
      continue;
    }

    if (currentHunk) {
      // Ignore trailing empty line at very end of file
      if (i === lines.length - 1 && line === "") {
        continue;
      }
      if (line.startsWith("\\ No newline at end of file")) {
        continue;
      }
      if (line.startsWith("+")) {
        currentHunk.actualNewLines++;
      } else if (line.startsWith("-")) {
        currentHunk.actualOldLines++;
      } else if (line.startsWith(" ") || line === "") {
        // Note: empty line inside a hunk is often an unprefixed blank context line
        if (line === "") {
          warnings.push(
            `Unprefixed empty line inside hunk at line ${i + 1} (${currentHunk.file || "unknown"}); treated as context line.`
          );
        }
        currentHunk.actualOldLines++;
        currentHunk.actualNewLines++;
      } else {
        // Non-diff line reached
        finishHunk();
      }
    }
  }
  finishHunk();

  if (hunks.length === 0) {
    errors.push(
      "No valid unified diff hunks ('@@ -old,count +new,count @@') found in patch content."
    );
  }

  // Reconstruct recounted diff (fixing only @@ header counts if needed)
  const recountedLines = [...lines];
  for (const h of hunks) {
    if (!h.countMatched) {
      recountedLines[h.headerLineIndex] =
        `@@ -${h.oldStart},${h.actualOldLines} +${h.newStart},${h.actualNewLines} @@${h.trailingHeader}`;
    }
  }
  const recountedContent = recountedLines.join("\n");

  // Validate target file paths against writeRoots
  const fileList = Array.from(targetFiles);
  let pathScopeValid = fileList.length > 0 && hunks.every((h) => h.file);
  if (!pathScopeValid) errors.push("Patch must identify target files for every hunk");
  const pathChecks = [];
  for (const f of fileList) {
    const check = checkPathWithinRoots(f, writeRoots);
    pathChecks.push({ file: f, ...check });
    if (!check.allowed) {
      pathScopeValid = false;
      errors.push(check.reason);
    }
  }

  const hunkCountValid = hunks.length > 0 && hunks.every((h) => h.countMatched);

  return {
    valid: errors.length === 0,
    hunkCountValid,
    pathScopeValid,
    targetFiles: fileList,
    pathChecks,
    hunkCount: hunks.length,
    hunkSummary: hunks.map((h) => ({
      file: h.file,
      line: h.headerLineNumber,
      declared: `-${h.oldStart},${h.expectedOldLines} +${h.newStart},${h.expectedNewLines}`,
      actual: `-${h.oldStart},${h.actualOldLines} +${h.newStart},${h.actualNewLines}`,
      countMatched: h.countMatched,
    })),
    errors,
    warnings,
    recountedContent,
  };
}

/**
 * Validate a `baseline_copy` JSON specification (array of { source, destination } items).
 */
export function validateBaselineCopy(rawContent, { readRoots = [], writeRoots = [], cwd = null } = {}) {
  const errors = [];
  const warnings = [];
  const targetFiles = [];
  let parsed;

  try {
    parsed = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent;
  } catch (err) {
    return {
      valid: false,
      pathScopeValid: false,
      targetFiles: [],
      itemCount: 0,
      errors: [`Invalid JSON in baseline_copy payload: ${err.message}`],
      warnings: [],
    };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return {
      valid: false,
      pathScopeValid: false,
      targetFiles: [],
      itemCount: 0,
      errors: ["baseline_copy payload must be a non-empty JSON array of { source, destination } objects."],
      warnings: [],
    };
  }

  let pathScopeValid = true;
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (!item || typeof item.source !== "string" || typeof item.destination !== "string") {
      errors.push(`Item at index ${i} is missing string 'source' or 'destination'.`);
      continue;
    }

    if (readRoots.length > 0) {
      const srcCheck = checkPathWithinRoots(item.source, readRoots);
      if (!srcCheck.allowed) {
        pathScopeValid = false;
        errors.push(`Source path violation at index ${i}: ${srcCheck.reason}`);
      }
    }

    const dstCheck = checkPathWithinRoots(item.destination, writeRoots);
    if (!dstCheck.allowed) {
      pathScopeValid = false;
      errors.push(`Destination path violation at index ${i}: ${dstCheck.reason}`);
    } else {
      targetFiles.push(dstCheck.normalizedPath);
    }

    if (cwd) {
      const absSrc = path.resolve(cwd, item.source);
      if (!fs.existsSync(absSrc)) {
        errors.push(`Source file does not exist: ${item.source}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    pathScopeValid,
    targetFiles,
    itemCount: parsed.length,
    errors,
    warnings,
  };
}

/**
 * Optionally run `git apply --check` (and `--recount` fallback check) against `cwd`.
 */
export async function checkGitApply(rawDiff, cwd) {
  if (!cwd || !fs.existsSync(cwd)) {
    return { checked: false, reason: "Working directory not provided or does not exist" };
  }

  const strictRes = await runCommand({
    command: "git",
    args: ["apply", "--check", "-"],
    cwd,
    stdinText: rawDiff.endsWith("\n") ? rawDiff : `${rawDiff}\n`,
    timeoutMs: 15_000,
  });

  if (strictRes.ok) {
    return {
      checked: true,
      appliesCleanly: true,
      requiresRecount: false,
      stderr: "",
    };
  }

  const recountRes = await runCommand({
    command: "git",
    args: ["apply", "--check", "--recount", "-"],
    cwd,
    stdinText: rawDiff.endsWith("\n") ? rawDiff : `${rawDiff}\n`,
    timeoutMs: 15_000,
  });

  return {
    checked: true,
    appliesCleanly: recountRes.ok,
    requiresRecount: recountRes.ok,
    strictError: strictRes.stderr || strictRes.error,
    recountError: recountRes.ok ? null : recountRes.stderr || recountRes.error,
  };
}
