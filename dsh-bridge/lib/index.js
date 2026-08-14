/**
 * dsh-companion-bridge: local gateway from the DSH Companion desktop shell
 * into a running dsh host. Exposes the host ApiProxy on 127.0.0.1 as plain
 * HTTP + SSE so a non-node process can drive sessions:
 *
 *   GET  /health              → { ok, bridge }
 *   GET  /events              → SSE; every mux + host frame as one JSON line
 *   POST /call                → { path: "sessions.prompt", payload: {...} }
 *                               generic ApiProxy dispatch; returns the
 *                               RpcResponse verbatim. path "respond" maps to
 *                               apiProxy.respond (question/approval answers).
 *
 * Auth: every request must carry the shared token (x-companion-token header
 * or ?token=). Port and token come from config, falling back to
 * DSH_COMPANION_BRIDGE_PORT / DSH_COMPANION_BRIDGE_TOKEN — the shell sets
 * both when it spawns the host. Binds 127.0.0.1 only.
 * @module dsh-companion-bridge
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from 'schemastery';
export const name = 'dsh-companion-bridge';
// apiProxy exists only in the web profile; requiring it here would leave this
// entry pending (and fail boot) under headless/TUI. The bridge body waits for
// it via ctx.inject instead, staying dormant in profiles that never provide it.
export const inject = ['tools', 'systemPrompt'];
export const Config = z.object({
    port: z.number().step(1).min(0).max(65_535).default(0)
        .description('Listen port on 127.0.0.1; 0 falls back to $DSH_COMPANION_BRIDGE_PORT'),
    token: z.string().role('secret').default('')
        .description('Shared secret; empty falls back to $DSH_COMPANION_BRIDGE_TOKEN'),
});
const MAX_BODY_BYTES = 1024 * 1024;
function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
function json(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
}
export function apply(outer, config) {
    outer.inject(['apiProxy'], (scope) => applyBridge(scope, config));
}
function applyBridge(ctx, config) {
    const port = config.port !== undefined && config.port !== 0
        ? config.port
        : Number(process.env.DSH_COMPANION_BRIDGE_PORT ?? 0);
    const token = config.token !== undefined && config.token !== ''
        ? config.token
        : process.env.DSH_COMPANION_BRIDGE_TOKEN ?? '';
    if (port === 0 || Number.isNaN(port)) {
        // Not configured: stay mounted but inert, so the plugin is safe to ship enabled.
        return;
    }
    const authorized = (req) => {
        if (token === '')
            return true;
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const presented = req.headers['x-companion-token'] ?? url.searchParams.get('token') ?? '';
        return presented === token;
    };
    const rpc = (payload) => ({ rpcId: RpcId(randomUUID()), payload });
    // ---- Reverse RPC: host-side tools calling into the connected companion ----
    const sseClients = new Set();
    const pendingRpc = new Map();
    const companionCall = (method, params, timeoutMs = 15_000) => {
        if (sseClients.size === 0) {
            return Promise.reject(new Error('no companion client is connected to receive this request'));
        }
        const id = randomUUID();
        const line = `data: ${JSON.stringify({ stream: 'companion', rpcId: id, frame: { method, params } })}\n\n`;
        for (const client of sseClients)
            client.write(line);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingRpc.delete(id);
                reject(new Error(`companion did not answer ${method} within ${timeoutMs}ms`));
            }, timeoutMs);
            pendingRpc.set(id, (result) => {
                clearTimeout(timer);
                pendingRpc.delete(id);
                if (result.ok)
                    resolve(result.value);
                else
                    reject(new Error(result.error ?? 'companion rejected the request'));
            });
        });
    };
    const handleEvents = (res) => {
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        const abort = new AbortController();
        const send = (stream, rpcId, frame) => {
            res.write(`data: ${JSON.stringify({ stream, rpcId, frame })}\n\n`);
        };
        const pump = async (stream) => {
            const source = stream === 'mux'
                ? ctx.apiProxy.events.mux(rpc({}), abort.signal)
                : ctx.apiProxy.events.host(rpc({}), abort.signal);
            for await (const frame of source)
                send(stream, String(frame.rpcId), frame.payload);
        };
        for (const stream of ['mux', 'host']) {
            pump(stream).catch((error) => {
                if (!abort.signal.aborted) {
                    send(stream, '', { type: 'stream/error', error: { message: String(error) } });
                }
            });
        }
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
        res.on('close', () => {
            sseClients.delete(res);
            clearInterval(heartbeat);
            abort.abort();
        });
    };
    const handleCall = async (req, res) => {
        let parsed;
        try {
            parsed = JSON.parse(await readBody(req));
        }
        catch (error) {
            json(res, 400, { ok: false, error: String(error) });
            return;
        }
        const path = typeof parsed.path === 'string' ? parsed.path : '';
        try {
            if (path === 'respond') {
                const receipt = await ctx.apiProxy.respond(parsed.payload);
                json(res, 200, { ok: true, result: receipt });
                return;
            }
            const [domain, method] = path.split('.', 2);
            const domainApi = ctx.apiProxy[domain ?? ''];
            const fn = domainApi?.[method ?? ''];
            if (typeof fn !== 'function') {
                json(res, 404, { ok: false, error: `unknown path: ${path}` });
                return;
            }
            const response = await fn.call(domainApi, rpc(parsed.payload));
            json(res, 200, { ok: true, result: response });
        }
        catch (error) {
            json(res, 500, { ok: false, error: String(error) });
        }
    };
    const server = createServer((req, res) => {
        if (!authorized(req)) {
            json(res, 401, { ok: false, error: 'bad token' });
            return;
        }
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        if (req.method === 'GET' && pathname === '/health') {
            json(res, 200, { ok: true, bridge: '0.1.0' });
        }
        else if (req.method === 'GET' && pathname === '/events') {
            handleEvents(res);
        }
        else if (req.method === 'POST' && pathname === '/call') {
            void handleCall(req, res);
        }
        else if (req.method === 'POST' && pathname === '/rpc-result') {
            void (async () => {
                try {
                    const body = JSON.parse(await readBody(req));
                    const resolver = typeof body.id === 'string' ? pendingRpc.get(body.id) : undefined;
                    if (resolver)
                        resolver({ ok: body.ok === true, value: body.value, error: body.error });
                    json(res, 200, { ok: true });
                }
                catch (error) {
                    json(res, 400, { ok: false, error: String(error) });
                }
            })();
        }
        else {
            json(res, 404, { ok: false, error: 'not found' });
        }
    });
    const TEXT_OUTPUT = {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
    };
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'create_automation',
        description: 'Create a scheduled automation in the Cetus desktop app: the given prompt runs automatically on the given schedule (recurring or one-shot) in its own conversation.',
        parameters: {
            name: { type: 'string', required: true, description: 'Short human-readable automation name' },
            prompt: { type: 'string', required: true, description: 'The prompt to run on schedule' },
            schedule_kind: { type: 'string', required: true, enum: ['interval', 'daily', 'cron', 'once'], description: 'interval: every N minutes; daily: local time on weekdays; cron: 5-field expression; once: absolute epoch-ms' },
            every_minutes: { type: 'number', description: 'For interval: run every N minutes' },
            time: { type: 'string', description: 'For daily: local wall-clock time "HH:MM"' },
            weekdays: { type: 'array', items: { type: 'number' }, description: 'For daily: 0=Sun..6=Sat; empty = every day' },
            cron_expr: { type: 'string', description: 'For cron: standard 5-field expression, local time' },
            at_ms: { type: 'number', description: 'For once: absolute epoch milliseconds' },
        },
        output: TEXT_OUTPUT,
        execute: async (args) => {
            const a = args;
            const kind = String(a.schedule_kind ?? '');
            const schedule = kind === 'interval' ? { kind: 'interval', everyMinutes: Number(a.every_minutes ?? 0) }
                : kind === 'daily' ? { kind: 'daily', time: String(a.time ?? ''), weekdays: Array.isArray(a.weekdays) ? a.weekdays : [] }
                    : kind === 'cron' ? { kind: 'cron', expr: String(a.cron_expr ?? '') }
                        : kind === 'once' ? { kind: 'once', atMs: Number(a.at_ms ?? 0) }
                            : undefined;
            if (!schedule)
                throw new Error(`create_automation: unknown schedule_kind ${JSON.stringify(kind)}`);
            const created = await companionCall('automation.create', {
                name: String(a.name ?? ''),
                prompt: String(a.prompt ?? ''),
                schedule,
            });
            const next = created?.nextRunAt ? new Date(created.nextRunAt).toLocaleString() : 'unscheduled';
            return `Automation "${created?.name ?? a.name}" created (next run: ${next}). The user can manage it in the Automations panel.`;
        },
    })), 'dsh-companion-bridge.tool.create-automation');
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'search_screen_history',
        description: "Search the user's on-device screen history (OCR + window text captured by Cetus Screen Context) for a keyword. Use when the user asks about something they saw or did on screen earlier.",
        parameters: {
            query: { type: 'string', required: true, description: 'Keyword to search for' },
            hours: { type: 'number', description: 'How many hours back to search (default 8, max 168)' },
            app: { type: 'string', description: 'Optional app-name filter' },
        },
        output: TEXT_OUTPUT,
        execute: async (args) => {
            const a = args;
            return String(await companionCall('screen.search', {
                query: String(a.query ?? ''),
                hours: typeof a.hours === 'number' ? a.hours : 8,
                app: typeof a.app === 'string' ? a.app : '',
            }));
        },
    })), 'dsh-companion-bridge.tool.screen-search');
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'screen_timeline',
        description: "Chronological timeline of the apps/windows/pages the user had on screen (from Cetus Screen Context). Use for questions like 'what did I work on today?'.",
        parameters: {
            hours: { type: 'number', description: 'How many hours back (default 8, max 168)' },
        },
        output: TEXT_OUTPUT,
        execute: async (args) => {
            const a = args;
            return String(await companionCall('screen.timeline', {
                hours: typeof a.hours === 'number' ? a.hours : 8,
            }));
        },
    })), 'dsh-companion-bridge.tool.screen-timeline');
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'list_automations',
        description: 'List the scheduled automations configured in the Cetus desktop app.',
        parameters: {},
        output: TEXT_OUTPUT,
        execute: async () => JSON.stringify(await companionCall('automation.list', {}), null, 2),
    })), 'dsh-companion-bridge.tool.list-automations');
    ctx.effect(() => ctx.systemPrompt.section({
        name: 'tool:dsh-companion-bridge',
        order: 118,
        text: '## Cetus desktop app\nYou are running inside Cetus, a desktop assistant app. When the user asks for something to happen on a schedule (daily summaries, periodic checks, reminders), do NOT write cron files or launchd jobs — call the create_automation tool instead; the app runs the prompt on schedule in its own conversation. Use list_automations to see what already exists. For questions about what the user saw or did on screen earlier, use screen_timeline (overview) and search_screen_history (keyword) — the attached Recent-activity context only covers the last few minutes.',
    }), 'dsh-companion-bridge.prompt');
    ctx.effect(() => {
        server.listen(port, '127.0.0.1');
        server.on('listening', () => {
            console.error(`[dsh-companion-bridge] listening on 127.0.0.1:${port}`);
        });
        return () => {
            server.closeAllConnections();
            server.close();
        };
    }, 'dsh-companion-bridge.server');
}
