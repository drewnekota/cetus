/**
 * dsh-artifact: a file-delivery protocol for dsh clients. Registers a
 * `send_artifact` tool the model calls to formally hand a produced file to
 * the user. The tool validates the file and attaches a structured descriptor
 * to the tool result's presentation `meta` — every client consuming the
 * standard `events.mux` stream sees it on the `tool/result` event and renders
 * it its own way (desktop shells show a preview card, IM bridges send the
 * file, headless clients log the path). No custom transport involved.
 * @module dsh-artifact
 */
import { stat } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'dsh-artifact';
export const inject = ['tools', 'systemPrompt'];
const KIND_BY_EXT = {
    '.png': ['image', 'image/png'],
    '.jpg': ['image', 'image/jpeg'],
    '.jpeg': ['image', 'image/jpeg'],
    '.webp': ['image', 'image/webp'],
    '.gif': ['image', 'image/gif'],
    '.svg': ['image', 'image/svg+xml'],
    '.mp4': ['video', 'video/mp4'],
    '.mov': ['video', 'video/quicktime'],
    '.webm': ['video', 'video/webm'],
    '.mp3': ['audio', 'audio/mpeg'],
    '.wav': ['audio', 'audio/wav'],
    '.m4a': ['audio', 'audio/mp4'],
    '.pdf': ['pdf', 'application/pdf'],
    '.md': ['markdown', 'text/markdown'],
    '.markdown': ['markdown', 'text/markdown'],
    '.html': ['html', 'text/html'],
    '.htm': ['html', 'text/html'],
    '.txt': ['text', 'text/plain'],
    '.log': ['text', 'text/plain'],
    '.json': ['text', 'application/json'],
    '.csv': ['text', 'text/csv'],
    '.yaml': ['text', 'text/yaml'],
    '.yml': ['text', 'text/yaml'],
};
/** Pure descriptor construction — exported for tests and client authors. */
export function describeArtifact(path, caption, sizeBytes) {
    const [artifactKind, mimeType] = KIND_BY_EXT[extname(path).toLowerCase()] ?? ['other', 'application/octet-stream'];
    return {
        kind: 'artifact',
        artifactKind,
        path,
        name: basename(path),
        mimeType,
        caption,
        sizeBytes,
    };
}
const PROMPT_TEXT = `## Delivering files (send_artifact)
When your work produces a file the user should receive — a document you drafted, a generated image, an export, a report — call send_artifact with its absolute path after writing it. This formally delivers the file to the user's interface (preview card, download, or forwarded file, depending on the client). Writing a file to disk alone does NOT surface it to the user. Deliver each final file once; do not re-send unchanged files or deliver intermediate scratch files.`;
export function apply(ctx) {
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'send_artifact',
        description: 'Deliver a produced file to the user\'s interface. Call this after writing any file the user should receive (documents, images, exports, reports). Accepts an absolute path.',
        parameters: {
            path: {
                type: 'string',
                required: true,
                description: 'Absolute path of the file to deliver',
            },
            caption: {
                type: 'string',
                description: 'Optional one-line caption shown with the file',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
            presentationMeta: (args, _value) => {
                const input = args;
                const path = typeof input.path === 'string' ? input.path : '';
                const caption = typeof input.caption === 'string' && input.caption !== '' ? input.caption : null;
                // Size is re-checked in execute; meta is a pure projection of args,
                // so it stats lazily via the cached size map below.
                const sizeBytes = sizeCache.get(path) ?? 0;
                return describeArtifact(path, caption, sizeBytes);
            },
        },
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const input = args;
            const path = typeof input.path === 'string' ? input.path : '';
            if (path === '')
                throw new Error('send_artifact: path is required');
            if (!isAbsolute(path))
                throw new Error(`send_artifact: path must be absolute, got ${JSON.stringify(path)}`);
            const info = await stat(path).catch(() => {
                throw new Error(`send_artifact: file not found: ${path}`);
            });
            if (!info.isFile())
                throw new Error(`send_artifact: not a regular file: ${path}`);
            sizeCache.set(path, info.size);
            const descriptor = describeArtifact(path, typeof input.caption === 'string' && input.caption !== '' ? input.caption : null, info.size);
            // Two delivery channels: the presentation meta above for clients on
            // dsh's own event stream, and Cetus's `CETUS_ARTIFACT:` marker in
            // the visible tool result for clients that only see the standard
            // ACP tool lifecycle (Cetus promotes the marker into a file card).
            const marker = `CETUS_ARTIFACT:${JSON.stringify({ path, sizeBytes: info.size, caption: descriptor.caption })}`;
            return `Delivered ${descriptor.name} (${descriptor.artifactKind}, ${info.size} bytes) to the user.\n${marker}`;
        },
    })), 'dsh-artifact.tool');
    ctx.effect(() => ctx.systemPrompt.section({
        name: 'tool:dsh-artifact',
        order: 117,
        text: PROMPT_TEXT,
    }), 'dsh-artifact.prompt');
}
/** path → last verified size, bridging execute (async fs) to the pure meta projection. */
const sizeCache = new Map();
