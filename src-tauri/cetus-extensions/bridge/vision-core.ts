/**
 * vision-core — a dependency-free OpenAI-compatible vision client, shared
 * verbatim between dsh-vision (the dsh `view_image` plugin) and cetus's pi
 * extensions (vision-bridge / document-bridge).
 *
 * CANONICAL COPY: dsh-vision/src/vision-core.ts
 * SYNCED COPY:    cetus/src-tauri/cetus-extensions/bridge/vision-core.ts
 * Edit the canonical copy and re-copy the whole file; do not let them drift.
 *
 * One request shape covers every backend — Zhipu, DashScope/Qwen, Volcano Ark,
 * Moonshot, Ollama, OpenAI, and Gemini via its OpenAI-compatibility endpoint
 * (https://generativelanguage.googleapis.com/v1beta/openai): POST
 * {baseURL}/chat/completions with an image_url content part. A "provider" is
 * therefore just { baseURL, model, apiKey } — no per-provider adapters.
 *
 * @module vision-core
 */

import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'

/** Everything one vision call needs; `fetch` is injectable as a test seam. */
export interface VisionRequest {
  baseURL: string
  apiKey: string
  model: string
  maxTokens: number
  timeoutMs: number
  maxImageBytes: number
  source: string
  question: string
  signal?: AbortSignal
  fetch?: typeof fetch
  /** Prefix for error messages (the tool/feature name the user will see). */
  label?: string
}

/** One endpoint+model in a fallback chain. `apiKey` may be resolved by the
 *  caller (config, env, keychain); empty/absent means "no key" — allowed only
 *  for local endpoints. */
export interface VisionProviderSpec {
  /** Short name used in aggregated error messages, e.g. "gemini", "ark". */
  id?: string
  baseURL: string
  model: string
  apiKey?: string
}

/** Per-call parameters shared by every provider in a chain. */
export interface VisionChainRequest {
  source: string
  question: string
  maxTokens?: number
  timeoutMs?: number
  maxImageBytes?: number
  signal?: AbortSignal
  fetch?: typeof fetch
  label?: string
  /** Return false to stop the chain and rethrow this provider's error as-is
   *  (e.g. dsh's "only retry on 429/404/5xx" policy). Default: any failure
   *  falls through to the next provider (a Gemini geo-block is a 400). */
  retriable?: (error: Error) => boolean
}

const DEFAULT_MAX_TOKENS = 2048
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
}

/** No key needed for a model server on this machine. */
export function isLocalEndpoint(baseURL: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(baseURL)
}

/** Resolve `source` to a URL the endpoint accepts: pass URLs through, base64 local files. */
export async function toImageUrl(source: string, maxImageBytes: number, label = 'view_image'): Promise<string> {
  if (/^(https?|data):/.test(source)) return source
  const mime = MIME_BY_EXT[extname(source).toLowerCase()]
  if (mime === undefined) {
    const supported = Object.keys(MIME_BY_EXT).join(' ')
    throw new Error(`${label}: unsupported image extension in ${JSON.stringify(source)} (supported: ${supported}, or pass an http(s)/data: URL)`)
  }
  const info = await stat(source).catch(() => {
    throw new Error(`${label}: file not found: ${source}`)
  })
  if (info.size > maxImageBytes) {
    throw new Error(`${label}: image is ${info.size} bytes, over the ${maxImageBytes}-byte limit (raise maxImageBytes in the config)`)
  }
  const bytes = await readFile(source)
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/** Pull assistant text out of an OpenAI-compatible response; content may be a string or parts. */
function extractText(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const message = (choices[0] as { message?: { content?: unknown } }).message
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .map(part => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string') ? (part as { text: string }).text : '')
      .filter(text => text !== '')
    if (parts.length > 0) return parts.join('\n')
  }
  return undefined
}

/** Ask the VLM one question about one image; returns the answer text or throws with a redacted message. */
export async function visionChat(request: VisionRequest): Promise<string> {
  const label = request.label ?? 'view_image'
  const doFetch = request.fetch ?? fetch
  const url = `${request.baseURL.replace(/\/$/, '')}/chat/completions`
  const imageUrl = await toImageUrl(request.source, request.maxImageBytes, label)
  const signals = [AbortSignal.timeout(request.timeoutMs), ...request.signal === undefined ? [] : [request.signal]]
  const redact = (text: string): string => request.apiKey === '' ? text : text.replaceAll(request.apiKey, '***')

  let response: Response
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...request.apiKey === '' ? {} : { authorization: `Bearer ${request.apiKey}` },
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            { type: 'text', text: request.question },
          ],
        }],
      }),
      signal: AbortSignal.any(signals),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(redact(`${label}: request to ${url} failed: ${reason}`))
  }

  const body = await response.text()
  if (!response.ok) {
    throw new Error(redact(`${label}: ${url} returned ${response.status}: ${body.slice(0, 500)}`))
  }
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    throw new Error(redact(`${label}: ${url} returned non-JSON body: ${body.slice(0, 200)}`))
  }
  const text = extractText(payload)
  if (text === undefined) {
    throw new Error(redact(`${label}: no assistant text in response: ${body.slice(0, 300)}`))
  }
  const cleaned = stripThink(text)
  if (cleaned === '') {
    throw new Error(`${label}: model returned only reasoning and no answer (try raising maxTokens)`)
  }
  return cleaned
}

/**
 * Try each provider in order until one answers. The image is resolved ONCE up
 * front, so a bad source (missing file, unsupported extension) throws
 * immediately instead of cycling the chain. Providers without a key are
 * skipped unless the endpoint is local. Throws an aggregated error when every
 * provider fails or none is usable.
 */
export async function visionChain(
  providers: VisionProviderSpec[],
  request: VisionChainRequest,
): Promise<{ text: string; provider: VisionProviderSpec }> {
  const label = request.label ?? 'view_image'
  const maxImageBytes = request.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
  const source = await toImageUrl(request.source, maxImageBytes, label)

  const errors: string[] = []
  let tried = 0
  for (const provider of providers) {
    const apiKey = provider.apiKey?.trim() ?? ''
    const name = provider.id ?? `${provider.baseURL} ${provider.model}`
    if (apiKey === '' && !isLocalEndpoint(provider.baseURL)) {
      continue
    }
    tried += 1
    try {
      const text = await visionChat({
        baseURL: provider.baseURL,
        model: provider.model,
        apiKey,
        maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxImageBytes,
        source,
        question: request.question,
        signal: request.signal,
        fetch: request.fetch,
        label,
      })
      return { text, provider }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      if (request.retriable !== undefined && !request.retriable(err)) throw err
      errors.push(`${name}: ${err.message}`)
    }
  }

  if (tried === 0) {
    throw new Error(`${label}: no vision provider configured (every provider in the chain is missing an API key)`)
  }
  throw new Error(errors.join('; '))
}

/**
 * Thinking-mode VLMs (e.g. glm-4.1v-thinking-flash) inline their reasoning as
 * <think>…</think> in the content. Strip it; a response that is ONLY an
 * unterminated think block (reasoning ate the token budget) becomes empty.
 */
export function stripThink(text: string): string {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  if (closed !== text) return closed.trim()
  if (/^\s*<think>/.test(text)) return ''
  return text.trim()
}
