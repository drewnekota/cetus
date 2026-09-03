/**
 * dsh-companion-bridge: Cetus-side tools for a dsh agent that Cetus drives
 * over the standard ACP stdio profile (`dsh --profile acp`).
 *
 * Earlier versions of this plugin also exposed dsh's host ApiProxy as an
 * HTTP + SSE gateway for the desktop shell; dsh 0.1.2 removed ApiProxy and
 * Cetus now speaks ACP to dsh directly, so the plugin only contributes tools
 * and a system-prompt section. The tools call back into the running Cetus app
 * over its control socket (`$CETUS_SOCK`, newline-delimited JSON — the same
 * door the `cetus` CLI uses), which Cetus puts in the agent's environment.
 * Without that variable the tools stay registered but report that Cetus is
 * unreachable, so the plugin is safe to leave mounted for plain `dsh` use.
 * @module dsh-companion-bridge
 */
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'dsh-companion-bridge';
export const inject = ['tools', 'systemPrompt'];
const HOUR_MS = 3_600_000;
/** One request/response exchange with the Cetus control socket. */
function cetusCall(op, params = {}, timeoutMs = 15_000) {
    const sock = process.env.CETUS_SOCK ?? '';
    if (sock === '') {
        return Promise.reject(new Error('Cetus is not reachable from this dsh process ($CETUS_SOCK is unset)'));
    }
    return new Promise((resolve, reject) => {
        const id = randomUUID();
        let buffer = '';
        let settled = false;
        const finish = (fn, value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            fn(value);
        };
        const timer = setTimeout(() => finish(reject, new Error(`Cetus did not answer ${op} within ${timeoutMs}ms`)), timeoutMs);
        const socket = createConnection(sock);
        socket.setEncoding('utf8');
        socket.on('connect', () => {
            socket.write(`${JSON.stringify({ id, op, ...params })}\n`);
        });
        socket.on('data', (chunk) => {
            buffer += chunk;
            const newline = buffer.indexOf('\n');
            if (newline === -1)
                return;
            const line = buffer.slice(0, newline);
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch (error) {
                finish(reject, new Error(`Cetus returned malformed JSON: ${String(error)}`));
                return;
            }
            if (parsed.ok === true)
                finish(resolve, parsed.result);
            else
                finish(reject, new Error(typeof parsed.error === 'string' ? parsed.error : `Cetus rejected ${op}`));
        });
        socket.on('error', (error) => finish(reject, new Error(`Cetus control socket error: ${String(error)}`)));
        socket.on('close', () => finish(reject, new Error(`Cetus closed the connection before answering ${op}`)));
    });
}
/** `context.*` results carry preformatted text in `result.text`. */
async function cetusText(op, params) {
    const result = await cetusCall(op, params);
    return typeof result?.text === 'string' ? result.text : JSON.stringify(result, null, 2);
}
function clampHours(value) {
    const hours = typeof value === 'number' && Number.isFinite(value) ? value : 8;
    return Math.min(Math.max(hours, 1), 168);
}
const TEXT_OUTPUT = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
};
export function apply(ctx) {
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
            const created = await cetusCall('automation.create', {
                input: {
                    name: String(a.name ?? ''),
                    prompt: String(a.prompt ?? ''),
                    schedule,
                },
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
            return cetusText('context.search', {
                q: String(a.query ?? ''),
                lastMs: clampHours(a.hours) * HOUR_MS,
                app: typeof a.app === 'string' ? a.app : '',
                limit: 20,
            });
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
            return cetusText('context.timeline', { lastMs: clampHours(a.hours) * HOUR_MS });
        },
    })), 'dsh-companion-bridge.tool.screen-timeline');
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'list_automations',
        description: 'List the scheduled automations configured in the Cetus desktop app.',
        parameters: {},
        output: TEXT_OUTPUT,
        execute: async () => JSON.stringify(await cetusCall('automation.list'), null, 2),
    })), 'dsh-companion-bridge.tool.list-automations');
    ctx.effect(() => ctx.systemPrompt.section({
        name: 'tool:dsh-companion-bridge',
        order: 118,
        text: '## Cetus desktop app\nYou are running inside Cetus, a desktop assistant app. When the user asks for something to happen on a schedule (daily summaries, periodic checks, reminders), do NOT write cron files or launchd jobs — call the create_automation tool instead; the app runs the prompt on schedule in its own conversation. Use list_automations to see what already exists. For questions about what the user saw or did on screen earlier, use screen_timeline (overview) and search_screen_history (keyword) — the attached Recent-activity context only covers the last few minutes.',
    }), 'dsh-companion-bridge.prompt');
}
