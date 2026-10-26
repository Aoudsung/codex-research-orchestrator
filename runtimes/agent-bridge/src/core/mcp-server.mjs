import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..");

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

const FIELD_ALIAS_HINTS = {
  from: "fromAgent",
  sender: "fromAgent",
  to: "toAgent (or use 'replyTo' to inherit recipient from an existing message)",
  recipient: "toAgent",
  target: "toAgent / assignedTo",
  agent: "toAgent / fromAgent / assignedTo",
  session: "sessionId / conversationId",
  diff: "content",
  patch: "content",
};

/**
 * Validate tool arguments strictly against a JSON Schema object.
 * Rejects unknown fields, missing required fields, and invalid enum values.
 *
 * @param {string} toolName
 * @param {object} schema
 * @param {Record<string, any>} args
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateToolArguments(toolName, schema, args) {
  const errors = [];
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {
      valid: false,
      errors: [`Arguments for '${toolName}' must be a JSON object.`],
    };
  }

  const properties = schema?.properties || {};
  const allowedKeys = Object.keys(properties);
  const requiredKeys = Array.isArray(schema?.required) ? schema.required : [];
  const allowAdditional = schema?.additionalProperties === true;

  // 1. Reject unknown fields strictly
  if (!allowAdditional) {
    for (const key of Object.keys(args)) {
      if (! Object.prototype.hasOwnProperty.call(properties, key)) {
        const hint = FIELD_ALIAS_HINTS[key]
          ? ` Did you mean '${FIELD_ALIAS_HINTS[key]}'?`
          : "";
        errors.push(
          `Unknown field '${key}' in tool '${toolName}'.${hint} Allowed fields: [${allowedKeys.join(", ")}].`
        );
      }
    }
  }

  // 2. Check required fields
  for (const reqKey of requiredKeys) {
    if (args[reqKey] === undefined || args[reqKey] === null || args[reqKey] === "") {
      errors.push(`Missing required field '${reqKey}' in tool '${toolName}'.`);
    }
  }

  // 3. Check enum and primitive type constraints
  for (const [key, val] of Object.entries(args)) {
    if (val === undefined || val === null) continue;
    const propSchema = properties[key];
    if (!propSchema) continue;

    if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(val)) {
      errors.push(
        `Invalid value '${val}' for field '${key}' in tool '${toolName}'. Allowed values: [${propSchema.enum.join(", ")}].`
      );
    }

    if (propSchema.type === "array" && !Array.isArray(val)) {
      errors.push(`Field '${key}' in tool '${toolName}' must be an array.`);
    } else if (propSchema.type === "boolean" && typeof val !== "boolean") {
      errors.push(`Field '${key}' in tool '${toolName}' must be a boolean.`);
    } else if (propSchema.type === "number" && typeof val !== "number") {
      errors.push(`Field '${key}' in tool '${toolName}' must be a number.`);
    } else if (propSchema.type === "string" && typeof val !== "string") {
      errors.push(`Field '${key}' in tool '${toolName}' must be a string.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Zero-dependency Model Context Protocol (MCP) Stdio Server.
 * Supports both standard MCP newline-delimited JSON-RPC 2.0 messages
 * and Content-Length header-framed messages for broad client compatibility.
 */
export class McpStdioServer {
  /**
   * @param {object} options
   * @param {string} options.name - Server identifier name
   * @param {string} options.version - Server version
   * @param {string} [options.instructions] - Optional server instructions for the model
   */
  constructor({ name, version = "0.2.0", instructions = "" }) {
    this.name = name;
    this.version = version;
    this.instructions = instructions;
    this.tools = new Map();
    this.resources = new Map();
    this.prompts = new Map();
    this.useContentLengthFraming = false;
    this._buffer = Buffer.alloc(0);
    this.bootMtimeMs = this._getMaxSourceMtimeMs();
    this._watchers = [];
  }

  /**
   * Compute maximum modification timestamp across src/core and src/servers for hot-reload detection.
   */
  _getMaxSourceMtimeMs() {
    let maxMtime = 0;
    for (const sub of ["core", "servers"]) {
      const dir = path.join(SRC_ROOT, sub);
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (!entry.endsWith(".mjs")) continue;
          const st = fs.statSync(path.join(dir, entry));
          if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
        }
      } catch {
        // ignore
      }
    }
    return maxMtime;
  }

  /**
   * Forward a single JSON-RPC request to a freshly spawned worker running the latest code on disk.
   */
  async _delegateToFreshWorker(msg) {
    const scriptPath = process.argv[1];
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (val) => {
        if (resolved) return;
        resolved = true;
        resolve(val);
      };

      const child = spawn(process.execPath, [scriptPath], {
        cwd: process.cwd(),
        env: { ...process.env, MCP_ONE_SHOT_WORKER: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString("utf8");
        let nl;
        while ((nl = stdout.indexOf("\n")) !== -1) {
          const line = stdout.slice(0, nl).trim();
          stdout = stdout.slice(nl + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (!Object.prototype.hasOwnProperty.call(parsed, "id")) {
              // Forward any JSON-RPC notifications emitted by the fresh worker
              this._send(parsed);
              continue;
            }
            if (parsed.id === msg.id) {
              child.kill();
              finish(parsed);
              return;
            }
          } catch {
            // wait for next line
          }
        }
      });

      child.on("error", () => finish(null));
      child.on("close", () => finish(null));

      child.stdin.write(`${JSON.stringify(msg)}\n`);
      child.stdin.end();
    });
  }

  /**
   * Register an MCP tool with strict input schema enforcement (`additionalProperties: false` by default).
   * @param {object} definition
   * @param {string} definition.name
   * @param {string} definition.description
   * @param {object} definition.inputSchema
   * @param {(args: Record<string, any>) => Promise<any> | any} handler
   */
  registerTool({ name, description, inputSchema }, handler) {
    const normalizedSchema = {
      type: "object",
      properties: {},
      additionalProperties: false,
      ...(inputSchema || {}),
    };
    this.tools.set(name, {
      definition: {
        name,
        description,
        inputSchema: normalizedSchema,
      },
      handler: (args) => {
        if (this.executionAdmission?.names.has(name)) this.executionAdmission.admit();
        return handler(args);
      },
    });
  }

  /**
   * Register an MCP resource.
   * @param {object} definition
   * @param {string} definition.uri
   * @param {string} definition.name
   * @param {string} [definition.description]
   * @param {string} [definition.mimeType]
   * @param {() => Promise<string | object> | string | object} handler
   */
  registerResource(
    { uri, name, description, mimeType = "application/json" },
    handler
  ) {
    this.resources.set(uri, {
      definition: { uri, name, description, mimeType },
      handler,
    });
  }

  /**
   * Log diagnostic output to stderr (never stdout, which is reserved for JSON-RPC).
   */
  log(...args) {
    if (process.env.MCP_DEBUG === "1" || process.env.MCP_DEBUG === "true") {
      process.stderr.write(`[${this.name}] ${args.map(String).join(" ")}\n`);
    }
  }

  /**
   * Start listening on stdin and writing JSON-RPC responses to stdout.
   */
  start() {
    process.stdin.on("data", (chunk) => {
      this._onData(chunk);
    });

    process.stdin.on("end", () => {
      this._closeWatchers();
      this.log("stdin closed, exiting.");
      process.exit(0);
    });

    process.on("uncaughtException", (err) => {
      this.log("Uncaught exception:", err?.stack || err);
    });

    process.on("unhandledRejection", (reason) => {
      this.log("Unhandled rejection:", reason);
    });

    if (!process.env.MCP_ONE_SHOT_WORKER) {
      this._setupHotReloadWatchers();
    }

    this.log(`Started MCP stdio server (${this.name}@${this.version})`);
  }

  /**
   * Send a JSON-RPC 2.0 notification to the connected MCP client over stdio.
   * @param {string} method
   * @param {object} [params]
   */
  sendNotification(method, params = undefined) {
    const payload = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    this._send(payload);
  }

  _setupHotReloadWatchers() {
    let debounceTimer = null;
    for (const sub of ["core", "servers"]) {
      const dir = path.join(SRC_ROOT, sub);
      try {
        const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
          if (filename && !filename.endsWith(".mjs")) return;
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            this._send({
              jsonrpc: "2.0",
              method: "notifications/tools/list_changed",
            });
          }, 150);
        });
        this._watchers.push(watcher);
      } catch {
        // ignore if fs.watch is unavailable
      }
    }
  }

  _closeWatchers() {
    for (const w of this._watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this._watchers = [];
  }

  /**
   * Parse incoming buffer supporting both Content-Length framing and newline-delimited JSON.
   * @param {Buffer} chunk
   */
  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);

    while (this._buffer.length > 0) {
      let startOffset = 0;
      while (
        startOffset < this._buffer.length &&
        (this._buffer[startOffset] === 0x0d ||
          this._buffer[startOffset] === 0x0a ||
          this._buffer[startOffset] === 0x20 ||
          this._buffer[startOffset] === 0x09)
      ) {
        startOffset++;
      }
      if (startOffset > 0) {
        this._buffer = this._buffer.subarray(startOffset);
      }
      if (this._buffer.length === 0) {
        break;
      }

      const preview = this._buffer
        .subarray(0, Math.min(32, this._buffer.length))
        .toString("utf8");

      if (/^Content-Length:/i.test(preview)) {
        this.useContentLengthFraming = true;
        const headerEnd = this._buffer.indexOf("\r\n\r\n");
        const lfHeaderEnd = this._buffer.indexOf("\n\n");
        let sepIndex = -1;
        let sepLength = 4;

        if (
          headerEnd !== -1 &&
          (lfHeaderEnd === -1 || headerEnd < lfHeaderEnd)
        ) {
          sepIndex = headerEnd;
          sepLength = 4;
        } else if (lfHeaderEnd !== -1) {
          sepIndex = lfHeaderEnd;
          sepLength = 2;
        }

        if (sepIndex === -1) {
          break;
        }

        const headerStr = this._buffer.subarray(0, sepIndex).toString("utf8");
        const match = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this._buffer = this._buffer.subarray(sepIndex + sepLength);
          continue;
        }

        const contentLength = parseInt(match[1], 10);
        const totalNeeded = sepIndex + sepLength + contentLength;
        if (this._buffer.length < totalNeeded) {
          break;
        }

        const bodyStr = this._buffer
          .subarray(sepIndex + sepLength, totalNeeded)
          .toString("utf8");
        this._buffer = this._buffer.subarray(totalNeeded);
        this._handleRawMessage(bodyStr);
      } else {
        const newlineIndex = this._buffer.indexOf(0x0a);
        if (newlineIndex === -1) {
          const tentative = this._buffer.toString("utf8").trim();
          if (tentative.startsWith("{") && tentative.endsWith("}")) {
            try {
              JSON.parse(tentative);
              this._buffer = Buffer.alloc(0);
              this._handleRawMessage(tentative);
              break;
            } catch {
              break;
            }
          }
          break;
        }

        const line = this._buffer
          .subarray(0, newlineIndex)
          .toString("utf8")
          .trim();
        this._buffer = this._buffer.subarray(newlineIndex + 1);
        if (line.length > 0) {
          this._handleRawMessage(line);
        }
      }
    }
  }

  /**
   * @param {string} raw
   */
  async _handleRawMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      this.log("Failed to parse JSON-RPC message:", err.message);
      this._send({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error",
        },
      });
      return;
    }

    if (Array.isArray(msg)) {
      for (const item of msg) {
        await this._dispatch(item);
      }
    } else {
      await this._dispatch(msg);
    }
  }

  /**
   * @param {object} msg
   */
  async _dispatch(msg) {
    if (!msg || typeof msg !== "object") return;

    const isNotification = msg.id === undefined;
    const method = msg.method;
    const params = msg.params || {};

    try {
      if (isNotification) {
        return;
      }

      // Hot-reload delegation: if source files on disk changed since this process booted,
      // transparently execute tools/list and tools/call against the latest code on disk.
      if (
        !process.env.MCP_ONE_SHOT_WORKER &&
        (method === "tools/list" || method === "tools/call") &&
        this._getMaxSourceMtimeMs() > this.bootMtimeMs
      ) {
        const delegated = await this._delegateToFreshWorker(msg);
        if (delegated) {
          this._send(delegated);
          return;
        }
      }

      let result;
      switch (method) {
        case "initialize": {
          const requestedVersion = params.protocolVersion;
          const negotiatedVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(
            requestedVersion
          )
            ? requestedVersion
            : "2024-11-05";

          result = {
            protocolVersion: negotiatedVersion,
            capabilities: {
              tools: { listChanged: true },
              resources: { subscribe: false, listChanged: true },
              prompts: { listChanged: false },
            },
            serverInfo: {
              name: this.name,
              version: this.version,
            },
          };
          if (this.instructions) {
            result.instructions = this.instructions;
          }
          break;
        }

        case "ping": {
          result = {};
          break;
        }

        case "tools/list": {
          result = {
            tools: Array.from(this.tools.values()).map((t) => t.definition),
          };
          break;
        }

        case "tools/call": {
          const toolName = params.name;
          const toolArgs = params.arguments || {};
          const entry = this.tools.get(toolName);
          if (!entry) {
            this._sendError(msg.id, -32602, `Unknown tool: ${toolName}`);
            return;
          }

          // Strict input schema validation before invoking tool handler
          const validation = validateToolArguments(
            toolName,
            entry.definition.inputSchema,
            toolArgs
          );
          if (!validation.valid) {
            result = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ok: false,
                      errorCode: "INVALID_TOOL_ARGUMENTS",
                      tool: toolName,
                      error: validation.errors.join(" "),
                      validationErrors: validation.errors,
                      allowedFields: Object.keys(
                        entry.definition.inputSchema?.properties || {}
                      ),
                    },
                    null,
                    2
                  ),
                },
              ],
              isError: true,
            };
            break;
          }

          try {
            const output = await entry.handler(toolArgs);
            if (
              output &&
              typeof output === "object" &&
              Array.isArray(output.content)
            ) {
              result = output;
            } else {
              const isLogicalError =
                output && typeof output === "object" && output.ok === false;
              const text =
                typeof output === "string"
                  ? output
                  : JSON.stringify(output, null, 2);
              result = {
                content: [{ type: "text", text }],
                isError: Boolean(isLogicalError && output.fatal),
              };
            }
          } catch (toolErr) {
            const errText =
              toolErr instanceof Error
                ? `${toolErr.message}\n${toolErr.stack || ""}`.trim()
                : String(toolErr);
            result = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      ok: false,
                      errorCode: toolErr?.code || "TOOL_EXECUTION_ERROR",
                      error:
                        toolErr instanceof Error
                          ? toolErr.message
                          : String(toolErr),
                      details: errText,
                    },
                    null,
                    2
                  ),
                },
              ],
              isError: true,
            };
          }
          break;
        }

        case "resources/list": {
          result = {
            resources: Array.from(this.resources.values()).map(
              (r) => r.definition
            ),
          };
          break;
        }

        case "resources/templates/list": {
          result = {
            resourceTemplates: [],
          };
          break;
        }

        case "resources/read": {
          const uri = params.uri;
          const entry = this.resources.get(uri);
          if (!entry) {
            this._sendError(msg.id, -32602, `Resource not found: ${uri}`);
            return;
          }
          const data = await entry.handler();
          const text =
            typeof data === "string" ? data : JSON.stringify(data, null, 2);
          result = {
            contents: [
              {
                uri,
                mimeType: entry.definition.mimeType || "application/json",
                text,
              },
            ],
          };
          break;
        }

        case "prompts/list": {
          result = {
            prompts: Array.from(this.prompts.values()).map((p) => p.definition),
          };
          break;
        }

        default: {
          this._sendError(msg.id, -32601, `Method not found: ${method}`);
          return;
        }
      }

      this._send({
        jsonrpc: "2.0",
        id: msg.id,
        result,
      });
    } catch (err) {
      this._sendError(
        msg.id,
        -32603,
        err instanceof Error ? err.message : "Internal error"
      );
    }
  }

  /**
   * @param {string|number|null} id
   * @param {number} code
   * @param {string} message
   */
  _sendError(id, code, message) {
    this._send({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message },
    });
  }

  /**
   * @param {object} payload
   */
  _send(payload) {
    const serialized = JSON.stringify(payload);
    if (this.useContentLengthFraming) {
      const byteLength = Buffer.byteLength(serialized, "utf8");
      process.stdout.write(`Content-Length: ${byteLength}\r\n\r\n${serialized}`);
    } else {
      process.stdout.write(`${serialized}\n`);
    }
  }
}
