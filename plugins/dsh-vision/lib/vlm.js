/**
 * Minimal OpenAI-compatible vision chat client over global fetch. One request
 * shape covers every backend (DashScope, Zhipu, Volcengine, Moonshot, Ollama,
 * OpenAI…): POST {baseURL}/chat/completions with an image_url content part.
 * @module dsh-vision/vlm
 */
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
const MIME_BY_EXT = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.heic': 'image/heic',
};
/** Resolve `source` to a URL the endpoint accepts: pass URLs through, base64 local files. */
export async function toImageUrl(source, maxImageBytes) {
    if (/^(https?|data):/.test(source))
        return source;
    const mime = MIME_BY_EXT[extname(source).toLowerCase()];
    if (mime === undefined) {
        const supported = Object.keys(MIME_BY_EXT).join(' ');
        throw new Error(`view_image: unsupported image extension in ${JSON.stringify(source)} (supported: ${supported}, or pass an http(s)/data: URL)`);
    }
    const info = await stat(source).catch(() => {
        throw new Error(`view_image: file not found: ${source}`);
    });
    if (info.size > maxImageBytes) {
        throw new Error(`view_image: image is ${info.size} bytes, over the ${maxImageBytes}-byte limit (raise maxImageBytes in the dsh-vision config)`);
    }
    const bytes = await readFile(source);
    return `data:${mime};base64,${bytes.toString('base64')}`;
}
/** Pull assistant text out of an OpenAI-compatible response; content may be a string or parts. */
function extractText(payload) {
    if (typeof payload !== 'object' || payload === null)
        return undefined;
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0)
        return undefined;
    const message = choices[0].message;
    const content = message?.content;
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        const parts = content
            .map(part => (typeof part === 'object' && part !== null && typeof part.text === 'string') ? part.text : '')
            .filter(text => text !== '');
        if (parts.length > 0)
            return parts.join('\n');
    }
    return undefined;
}
/** Ask the VLM one question about one image; returns the answer text or throws with a redacted message. */
export async function visionChat(request) {
    const doFetch = request.fetch ?? fetch;
    const url = `${request.baseURL.replace(/\/$/, '')}/chat/completions`;
    const imageUrl = await toImageUrl(request.source, request.maxImageBytes);
    const signals = [AbortSignal.timeout(request.timeoutMs), ...request.signal === undefined ? [] : [request.signal]];
    const redact = (text) => request.apiKey === '' ? text : text.replaceAll(request.apiKey, '***');
    let response;
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
        });
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(redact(`view_image: request to ${url} failed: ${reason}`));
    }
    const body = await response.text();
    if (!response.ok) {
        throw new Error(redact(`view_image: ${url} returned ${response.status}: ${body.slice(0, 500)}`));
    }
    let payload;
    try {
        payload = JSON.parse(body);
    }
    catch {
        throw new Error(redact(`view_image: ${url} returned non-JSON body: ${body.slice(0, 200)}`));
    }
    const text = extractText(payload);
    if (text === undefined) {
        throw new Error(redact(`view_image: no assistant text in response: ${body.slice(0, 300)}`));
    }
    const cleaned = stripThink(text);
    if (cleaned === '') {
        throw new Error('view_image: model returned only reasoning and no answer (try raising maxTokens)');
    }
    return cleaned;
}
/**
 * Thinking-mode VLMs (e.g. glm-4.1v-thinking-flash) inline their reasoning as
 * <think>…</think> in the content. Strip it; a response that is ONLY an
 * unterminated think block (reasoning ate the token budget) becomes empty.
 */
function stripThink(text) {
    const closed = text.replace(/<think>[\s\S]*?<\/think>/g, '');
    if (closed !== text)
        return closed.trim();
    if (/^\s*<think>/.test(text))
        return '';
    return text.trim();
}
