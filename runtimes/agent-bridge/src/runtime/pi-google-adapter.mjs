import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HYDROGEN_UNIFIED_CONTEXT_TOKENS = 1048576;
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

/**
 * Parse a leading major.minor.patch triplet from a package semver string.
 * @param {string | null | undefined} versionStr
 * @returns {[number, number, number] | null}
 */
export function parseSemverTriplet(versionStr) {
  if (typeof versionStr !== "string") return null;
  const match = versionStr.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[+-].*)?$/);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/**
 * Whether `@google/genai` supports official unary continuation (`>= 2.29.1`).
 * @param {string | null | undefined} versionStr
 */
export function supportsGoogleGenaiContinuation(versionStr) {
  const parts = parseSemverTriplet(versionStr);
  if (!parts) return false;
  const [major, minor, patch] = parts;
  return major > 2 || (major === 2 && (minor > 29 || (minor === 29 && patch >= 1)));
}

function resolveEnvValue(name, env) {
  return (env && env[name]) || process.env[name] || undefined;
}

function resolveVertexApiKey(apiKey) {
  const trimmed = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!trimmed || trimmed === GCP_VERTEX_CREDENTIALS_MARKER || /^<[^>]+>$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function resolveCustomBaseUrl(baseUrl) {
  const trimmed = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!trimmed || trimmed.includes("{location}")) {
    return undefined;
  }
  return trimmed;
}

function baseUrlIncludesApiVersion(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return url.pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part));
  } catch {
    return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
  }
}

async function importFromSdkRoot(sdkRoot, relPath) {
  const fullPath = path.join(sdkRoot, "node_modules", relPath);
  return await import(pathToFileURL(fullPath).href);
}

/**
 * Check synchronously whether loaded PI `google-shared.js` natively accepts `xhigh` -> `XHIGH`.
 * @param {object | null | undefined} googleSharedMod
 */
export function sdkSupportsGoogleXhigh(googleSharedMod) {
  try {
    return googleSharedMod?.toGoogleSdkThinkingLevel?.("XHIGH") === "XHIGH";
  } catch {
    return false;
  }
}

class LocalAssistantEventStream {
  constructor() {
    this.events = [];
    this.queue = [];
    this.waiting = [];
    this.done = false;
    this.ended = false;
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event) {
    if (this.ended) return;
    this.events.push(event);
    if ((event?.type === "done" || event?.type === "error") && !this.done) {
      this.done = true;
      this.resolveFinalResult(event.type === "done" ? event.message : event.error);
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  end(result) {
    this.done = true;
    this.ended = true;
    if (result !== undefined) {
      this.resolveFinalResult(result);
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift();
      } else if (this.ended) {
        return;
      } else {
        const next = await new Promise((resolve) => this.waiting.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  }

  result() {
    return this.finalResultPromise;
  }
}

/**
 * Build a self-contained Google Vertex stream wrapper so `agent-bridge` works cleanly
 * across PI SDK releases without mutating `~/.pi/agent/install/releases/*` files.
 */
export function createPiGoogleStreamWrapper({
  sdkRoot = null,
  runtime = null,
  originalStreamFunction,
  markRuntimeStreamFunction = null,
  googleVertexMod = null,
  googleSharedMod = null,
  googleGenaiVersion = null,
  onGenerationSettings = null,
} = {}) {
  let toolCallCounter = 0;

  function runSelfContainedHydrogenStream({ model, context, options }) {
    const stream = new LocalAssistantEventStream();

    (async () => {
      const output = {
        role: "assistant",
        content: [],
        api: "google-vertex",
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "pending",
        timestamp: Date.now(),
      };
      let formatProviderError = (err) => String(err?.message || err);
      let normalizeProviderError = (err) => err;

      try {
        if (!sdkRoot) {
          throw new Error("PI SDK root is required for self-contained Hydrogen unary adapter.");
        }
        if (options?.fetch && options.fetch !== globalThis.fetch) {
          throw new Error("Custom fetch is not supported by the Google Vertex adapter");
        }
        const [
          genaiMod,
          transcriptMod,
          textMod,
          sanitizeMod,
          headersMod,
          identityMod,
          errorMod,
          modelsMod,
          sharedMod,
        ] = await Promise.all([
          importFromSdkRoot(sdkRoot, "@google/genai/dist/node/index.mjs").catch(() =>
            importFromSdkRoot(sdkRoot, "@google/genai/dist/index.mjs")
          ),
          importFromSdkRoot(sdkRoot, "@earendil-works/pi-ai/dist/utils/transcript.js"),
          importFromSdkRoot(sdkRoot, "@earendil-works/pi-ai/dist/utils/text.js"),
          importFromSdkRoot(sdkRoot, "@earendil-works/pi-ai/dist/utils/sanitize-unicode.js"),
          importFromSdkRoot(sdkRoot, "@earendil-works/pi-ai/dist/utils/headers.js"),
          importFromSdkRoot(sdkRoot, "@earendil-works/pi-ai/dist/utils/identity.js"),
          importFromSdkRoot(sdkRoot, "@earendil-works/pi-ai/dist/utils/error-body.js"),
          importFromSdkRoot(sdkRoot, "@earendil-works/pi-ai/dist/models.js"),
          importFromSdkRoot(sdkRoot, "@earendil-works/pi-ai/dist/api/google-shared.js"),
        ]);

        const { GoogleGenAI, ResourceScope } = genaiMod;
        const { collapseSystemMessages, getCurrentTools, getInitialSystemMessage } = transcriptMod;
        const { getSystemMessageText } = textMod;
        const { sanitizeSurrogates } = sanitizeMod;
        const { providerHeadersToRecord } = headersMod;
        const { getIdentityHeaders } = identityMod;
        formatProviderError = errorMod.formatProviderError;
        normalizeProviderError = errorMod.normalizeProviderError;
        const { calculateCost } = modelsMod;
        const {
          convertMessages,
          convertTools,
          isThinkingPart,
          mapStopReason,
          resolveGoogleFunctionCallingMode,
          retainThoughtSignature,
          supportsGoogleStrictToolSampling,
        } = sharedMod;

        const normalizedContext = collapseSystemMessages(context);
        const authRes = await runtime?.getAuth?.(model, {
          apiKey: options?.apiKey,
          env: options?.env,
          signal: options?.signal,
        });
        const mergedEnv = {
          ...process.env,
          ...(authRes?.env || {}),
          ...(options?.env || {}),
        };
        const apiKey =
          resolveVertexApiKey(authRes?.auth?.apiKey) || resolveVertexApiKey(options?.apiKey);
        const requestModel = authRes?.auth?.baseUrl
          ? { ...model, baseUrl: authRes.auth.baseUrl }
          : model;

        let mergedHeaders = providerHeadersToRecord(
          getIdentityHeaders(requestModel, options?.identity),
          requestModel.headers,
          authRes?.auth?.headers,
          options?.headers
        );
        if (typeof options?.transformHeaders === "function") {
          mergedHeaders = await options.transformHeaders(mergedHeaders ?? {});
        }

        const httpOptions = {};
        const customBaseUrl = resolveCustomBaseUrl(requestModel.baseUrl);
        if (customBaseUrl) {
          httpOptions.baseUrl = customBaseUrl;
          if (ResourceScope?.COLLECTION !== undefined) {
            httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
          }
          if (baseUrlIncludesApiVersion(customBaseUrl)) {
            httpOptions.apiVersion = "";
          }
        }
        if (mergedHeaders && Object.keys(mergedHeaders).length > 0) {
          httpOptions.headers = mergedHeaders;
        }

        let client;
        if (apiKey) {
          client = new GoogleGenAI({
            vertexai: true,
            apiKey,
            apiVersion: "v1",
            ...(Object.keys(httpOptions).length > 0 ? { httpOptions } : {}),
          });
        } else {
          const project =
            options?.project ||
            resolveEnvValue("GOOGLE_CLOUD_PROJECT", mergedEnv) ||
            resolveEnvValue("GCLOUD_PROJECT", mergedEnv);
          const location =
            options?.location || resolveEnvValue("GOOGLE_CLOUD_LOCATION", mergedEnv);
          if (!project || !location) {
            throw new Error(
              "Vertex AI requires API key or GOOGLE_CLOUD_PROJECT/GOOGLE_CLOUD_LOCATION."
            );
          }
          const keyFilename = resolveEnvValue("GOOGLE_APPLICATION_CREDENTIALS", mergedEnv);
          client = new GoogleGenAI({
            vertexai: true,
            project,
            location,
            apiVersion: "v1",
            ...(keyFilename ? { googleAuthOptions: { keyFilename } } : {}),
            ...(Object.keys(httpOptions).length > 0 ? { httpOptions } : {}),
          });
        }

        const contents = convertMessages(requestModel, normalizedContext);
        const initialSystemMessage = getInitialSystemMessage(normalizedContext.messages);
        const currentTools = getCurrentTools(normalizedContext.messages);
        const supportsStrictMode = supportsGoogleStrictToolSampling(requestModel.id);
        const functionCallingMode =
          currentTools.length > 0
            ? resolveGoogleFunctionCallingMode(currentTools, options?.toolChoice, supportsStrictMode)
            : undefined;
        const systemInstruction = initialSystemMessage
          ? getSystemMessageText(initialSystemMessage)
          : "";
        const thinkingLevel = String(options?.reasoning || "xhigh").toUpperCase();

        const config = {
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(systemInstruction ? { systemInstruction: sanitizeSurrogates(systemInstruction) } : {}),
          ...(currentTools.length > 0
            ? { tools: convertTools(currentTools, false, supportsStrictMode) }
            : {}),
          ...(functionCallingMode !== undefined
            ? { toolConfig: { functionCallingConfig: { mode: functionCallingMode } } }
            : {}),
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: thinkingLevel === "OFF" ? "LOW" : thinkingLevel,
          },
          ...(options?.signal ? { abortSignal: options.signal } : {}),
        };
        if (options?.signal?.aborted) {
          throw new Error("Request aborted");
        }

        let params = { model: requestModel.id, contents, config };
        const nextParams = await options?.onPayload?.(params, requestModel);
        if (nextParams !== undefined) {
          params = nextParams;
        }

        const reqHttpOptions = {
          ...params.config?.httpOptions,
          apiVersion: "v1beta1",
          retryOptions: { attempts: 1 },
        };
        params.config = {
          ...params.config,
          httpOptions: reqHttpOptions,
          automaticContinuation: true,
        };

        const count = await client.models.countTokens({
          model: params.model,
          contents: params.contents,
          config: {
            httpOptions: reqHttpOptions,
            abortSignal: params.config.abortSignal,
            systemInstruction: params.config.systemInstruction,
            tools: params.config.tools,
            generationConfig: { thinkingConfig: params.config.thinkingConfig },
          },
        });
        if (
          !Number.isSafeInteger(count?.totalTokens) ||
          count.totalTokens < 0 ||
          count.totalTokens >= HYDROGEN_UNIFIED_CONTEXT_TOKENS
        ) {
          throw new Error("Hydrogen countTokens did not leave a valid unified output allowance");
        }
        params.config.maxOutputTokens = HYDROGEN_UNIFIED_CONTEXT_TOKENS - count.totalTokens;

        const settingsMeta = {
          protocol: "bridge-self-contained-unary-v1",
          apiVersion: "v1beta1",
          sdkVersion: googleGenaiVersion,
          transport: "unary",
          thinkingLevel: params.config.thinkingConfig.thinkingLevel,
          unifiedContextTokens: HYDROGEN_UNIFIED_CONTEXT_TOKENS,
          inputTokens: count.totalTokens,
          maxOutputTokens: params.config.maxOutputTokens,
          inputTokenSource: "countTokens",
          automaticContinuation: true,
          httpAttempts: 1,
          providerMaxRetries: 0,
        };
        await onGenerationSettings?.(settingsMeta);
        await options?.onProviderStreamEvent?.({ bridgeHydrogenLongDecode: settingsMeta }, requestModel);

        const response = await client.models.generateContent(params);
        if (response?.candidates?.some((c) => c.finishReason === "CONTINUATION")) {
          throw new Error("Hydrogen SDK returned an unfinished automatic continuation");
        }

        stream.push({ type: "start", partial: output });
        let currentBlock = null;
        const blocks = output.content;
        const blockIndex = () => blocks.length - 1;

        await options?.onProviderStreamEvent?.(response, requestModel);
        output.responseId ||= response?.responseId;
        const candidate = response?.candidates?.[0];
        if (candidate?.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.text !== undefined) {
              const isThinking = isThinkingPart(part);
              if (
                !currentBlock ||
                (isThinking && currentBlock.type !== "thinking") ||
                (!isThinking && currentBlock.type !== "text")
              ) {
                if (currentBlock) {
                  stream.push({
                    type: currentBlock.type === "text" ? "text_end" : "thinking_end",
                    contentIndex: blockIndex(),
                    content:
                      currentBlock.type === "text" ? currentBlock.text : currentBlock.thinking,
                    partial: output,
                  });
                }
                if (isThinking) {
                  currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
                  blocks.push(currentBlock);
                  stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
                } else {
                  currentBlock = { type: "text", text: "" };
                  blocks.push(currentBlock);
                  stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
                }
              }
              if (currentBlock.type === "thinking") {
                currentBlock.thinking += part.text;
                currentBlock.thinkingSignature = retainThoughtSignature(
                  currentBlock.thinkingSignature,
                  part.thoughtSignature
                );
                stream.push({
                  type: "thinking_delta",
                  contentIndex: blockIndex(),
                  delta: part.text,
                  partial: output,
                });
              } else {
                currentBlock.text += part.text;
                currentBlock.textSignature = retainThoughtSignature(
                  currentBlock.textSignature,
                  part.thoughtSignature
                );
                stream.push({
                  type: "text_delta",
                  contentIndex: blockIndex(),
                  delta: part.text,
                  partial: output,
                });
              }
            }
            if (part.functionCall) {
              if (currentBlock) {
                stream.push({
                  type: currentBlock.type === "text" ? "text_end" : "thinking_end",
                  contentIndex: blockIndex(),
                  content: currentBlock.type === "text" ? currentBlock.text : currentBlock.thinking,
                  partial: output,
                });
                currentBlock = null;
              }
              const providedId = part.functionCall.id;
              const needsNewId =
                !providedId ||
                blocks.some((b) => b.type === "toolCall" && b.id === providedId);
              const toolCallId = needsNewId
                ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
                : providedId;
              const toolCall = {
                type: "toolCall",
                id: toolCallId,
                name: part.functionCall.name || "",
                arguments: part.functionCall.args ?? {},
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
              };
              blocks.push(toolCall);
              stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
              stream.push({
                type: "toolcall_delta",
                contentIndex: blockIndex(),
                delta: JSON.stringify(toolCall.arguments),
                partial: output,
              });
              stream.push({
                type: "toolcall_end",
                contentIndex: blockIndex(),
                toolCall,
                partial: output,
              });
            }
          }
        }
        if (currentBlock) {
          stream.push({
            type: currentBlock.type === "text" ? "text_end" : "thinking_end",
            contentIndex: blockIndex(),
            content: currentBlock.type === "text" ? currentBlock.text : currentBlock.thinking,
            partial: output,
          });
        }
        if (candidate?.finishReason) {
          output.rawStopReason = candidate.finishReason;
          output.stopReason = mapStopReason(candidate.finishReason);
          if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
            output.stopReason = "toolUse";
          }
        }
        if (response?.usageMetadata) {
          output.usage = {
            input:
              (response.usageMetadata.promptTokenCount || 0) -
              (response.usageMetadata.cachedContentTokenCount || 0),
            output:
              (response.usageMetadata.candidatesTokenCount || 0) +
              (response.usageMetadata.thoughtsTokenCount || 0),
            cacheRead: response.usageMetadata.cachedContentTokenCount || 0,
            cacheWrite: 0,
            reasoning: response.usageMetadata.thoughtsTokenCount || 0,
            totalTokens: response.usageMetadata.totalTokenCount || 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          calculateCost(requestModel, output.usage);
        }
        if (options?.signal?.aborted) {
          throw new Error("Request was aborted");
        }
        if (output.stopReason === "pending") {
          throw new Error("Google Vertex response ended without a finish reason");
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          throw new Error(
            output.rawStopReason
              ? `Provider stopped with: ${output.rawStopReason}`
              : "An unknown error occurred"
          );
        }
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      } catch (err) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = formatProviderError(normalizeProviderError(err));
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    })();

    return stream;
  }

  const wrapper = (model, context, options = {}) => {
    // Case A: Non-google-vertex models pass straight through.
    if (model?.provider !== "google-vertex") {
      return originalStreamFunction(model, context, options);
    }

    // Case B: gemini-4-hydrogen official unary long-decode path.
    if (model.id === "gemini-4-hydrogen") {
      if (!supportsGoogleGenaiContinuation(googleGenaiVersion)) {
        throw new Error(
          `Hydrogen long decode requires @google/genai >=2.29.1 (found ${googleGenaiVersion || "unknown"}).`
        );
      }
      if (googleVertexMod?.bridgeHydrogenLongDecodeProtocol === "official-unary-v1") {
        return originalStreamFunction(model, context, {
          ...options,
          maxRetries: 0,
          metadata: {
            ...options?.metadata,
            bridgeHydrogenLongDecode: "official-unary-v1",
            bridgeHydrogenSdkVersion: googleGenaiVersion,
          },
        });
      }
      // Self-contained fallback when installed PI SDK lacks bridgeHydrogenLongDecodeProtocol.
      return runSelfContainedHydrogenStream({ model, context, options });
    }

    // Case C: Other google-vertex models requesting xhigh when unpatched SDK lacks XHIGH map.
    if (options?.reasoning === "xhigh" && !sdkSupportsGoogleXhigh(googleSharedMod)) {
      const origOnPayload = options?.onPayload;
      const forceXhighOnPayload = async (params, reqModel) => {
        const next = (await origOnPayload?.(params, reqModel)) ?? params;
        if (next && typeof next === "object") {
          next.config = {
            ...(next.config || {}),
            thinkingConfig: {
              ...(next.config?.thinkingConfig || {}),
              includeThoughts: true,
              thinkingLevel: "XHIGH",
            },
          };
        }
        return next;
      };
      return originalStreamFunction(model, context, {
        ...options,
        reasoning: "high",
        onPayload: forceXhighOnPayload,
      });
    }

    return originalStreamFunction(model, context, options);
  };

  if (typeof markRuntimeStreamFunction === "function" && runtime) {
    markRuntimeStreamFunction(wrapper, runtime);
  }
  return wrapper;
}

/**
 * Resolve installed `@google/genai` version string under an SDK root, if present.
 * @param {string | null | undefined} sdkRoot
 */
export function readGoogleGenaiVersion(sdkRoot) {
  if (!sdkRoot) return null;
  try {
    const pkgPath = path.join(sdkRoot, "node_modules", "@google", "genai", "package.json");
    if (!fs.existsSync(pkgPath)) return null;
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || null;
  } catch {
    return null;
  }
}
