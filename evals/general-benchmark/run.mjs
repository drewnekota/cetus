#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES_PATH = path.join(HERE, "cases.json");
const WORKSPACES = path.join(HERE, "workspaces");
const RESULTS = path.join(HERE, "results.json");
const SOCK = process.env.CETUS_DEVTEST_SOCK || "/tmp/cetus-devtest.sock";
const REQUEST_TIMEOUT_MS = Number(process.env.CETUS_BENCH_TIMEOUT_MS || 600_000);

const args = parseArgs(process.argv.slice(2));
const only = args.only ? new Set(String(args.only).split(",")) : null;
const includeGated = Boolean(args["include-gated"]);
const keepConversations = Boolean(args["keep-conversations"]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[name] = true;
    } else {
      out[name] = next;
      i++;
    }
  }
  return out;
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function writeFileSafe(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function setupWorkspace(testCase) {
  const workspace = path.join(WORKSPACES, testCase.id);
  rmrf(workspace);
  fs.mkdirSync(workspace, { recursive: true });

  for (const [name, content] of Object.entries(testCase.setupFiles || {})) {
    writeFileSafe(path.join(workspace, name), content);
  }
  for (const rel of testCase.copyFiles || []) {
    const from = path.resolve(HERE, rel);
    const to = path.join(workspace, path.basename(rel));
    fs.copyFileSync(from, to);
  }
  return workspace;
}

function request(op, payload = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: SOCK });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    let buf = "";
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id: `${Date.now()}-${Math.random()}`, op, ...payload }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      sock.end();
      const line = buf.slice(0, nl);
      try {
        const json = JSON.parse(line);
        if (json.ok === false) reject(new Error(json.error || "bridge error"));
        else resolve(json.result);
      } catch (error) {
        reject(error);
      }
    });
    sock.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function textFromMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (typeof block?.text === "string") return block.text;
        if (typeof block?.content === "string") return block.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof message?.text === "string") return message.text;
  return "";
}

function summarizeMessages(messages = []) {
  const assistant = [...messages].reverse().find((m) => m?.role === "assistant");
  const toolCount = messages.filter((m) => {
    const role = String(m?.role || "");
    return role.includes("tool");
  }).length;
  return {
    messageCount: messages.length,
    toolCount,
    finalAssistantText: textFromMessage(assistant).slice(0, 4000),
  };
}

function fileText(workspace, rel) {
  const file = path.join(workspace, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function includesAll(text, needles) {
  const hay = text.toLowerCase();
  return needles.every((needle) => hay.includes(String(needle).toLowerCase()));
}

function runCheck(workspace, command, args = []) {
  const res = spawnSync(command, args, {
    cwd: workspace,
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: (res.stdout || "").trim().slice(0, 2000),
    stderr: (res.stderr || "").trim().slice(0, 2000),
  };
}

function validationResult(checks) {
  return {
    passed: checks.every((c) => c.ok),
    checks,
  };
}

function validateCase(testCase, workspace, summary) {
  const finalText = summary.finalAssistantText || "";
  const nonEmptyFinal = {
    name: "final assistant text is non-empty",
    ok: finalText.trim().length >= 20,
  };

  switch (testCase.id) {
    case "fs-code-fix": {
      const test = runCheck(workspace, "node", ["test.js"]);
      return validationResult([
        nonEmptyFinal,
        { name: "node test.js passes", ok: test.ok, details: test },
        {
          name: "final mentions verification or passing tests",
          ok: /node test\.js|pnpm test|npm test|tests? pass|测试.*通过|通过.*测试/i.test(finalText),
        },
      ]);
    }
    case "repo-review":
      return validationResult([
        nonEmptyFinal,
        { name: "mentions SQL injection", ok: /sql injection|注入/i.test(finalText) },
        { name: "mentions invalid or negative amount", ok: /negative|invalid amount|amount validation|负数|金额/i.test(finalText) },
        { name: "mentions transaction or atomicity", ok: /transaction|atomic|事务|原子/i.test(finalText) },
        { name: "did not edit reviewed file", ok: fileText(workspace, "server.js").includes("db.query(`update accounts") },
      ]);
    case "csv-analysis": {
      const report = fileText(workspace, "report.md");
      return validationResult([
        nonEmptyFinal,
        { name: "report.md exists", ok: fs.existsSync(path.join(workspace, "report.md")) },
        { name: "report includes top products", ok: includesAll(report, ["Widget A", "Widget B", "Widget D"]) },
        { name: "report includes expected Widget A total", ok: /\$24,?000|24000/.test(report) },
        { name: "report includes month-over-month trend", ok: /month-over-month|环比|−7\.1|-7\.1|−7\.9|-7\.9|14\.5/.test(report) },
        { name: "report mentions verification", ok: /awk|script|verified|验证/i.test(report + "\n" + finalText) },
      ]);
    }
    case "current-web-research": {
      const combined = [finalText, fileText(workspace, "codex-features-summary.md")].join("\n");
      return validationResult([
        nonEmptyFinal,
        { name: "mentions Codex", ok: /codex/i.test(combined) },
        { name: "includes OpenAI source link", ok: /https:\/\/(developers\.openai\.com|openai\.com)\//i.test(combined) },
        { name: "mentions skills or MCP", ok: /skills?|mcp|connectors?/i.test(combined) },
        { name: "mentions parallel/worktree/thread capability", ok: /parallel|worktree|thread|并行|工作树/i.test(combined) },
      ]);
    }
    case "html-artifact": {
      const html = fileText(workspace, "index.html");
      return validationResult([
        nonEmptyFinal,
        { name: "index.html exists", ok: fs.existsSync(path.join(workspace, "index.html")) },
        { name: "index.html is self-contained HTML", ok: /<html[\s>]/i.test(html) && !/<script[^>]+src=|<link[^>]+href=/i.test(html) },
        { name: "index.html contains a visualization", ok: /<svg|<canvas|chart|bar|sparkline/i.test(html) },
        { name: "final mentions index.html path", ok: /index\.html/i.test(finalText) },
      ]);
    }
    case "memory-preference":
      return validationResult([
        nonEmptyFinal,
        { name: "final includes stored memory evidence", ok: /stored|已存储|存储好了|id:\s*`?[0-9a-f-]{8,}/i.test(finalText) },
        { name: "final mentions Memory management", ok: /memory|settings|记忆|设置/i.test(finalText) },
      ]);
    case "automation":
      return validationResult([
        nonEmptyFinal,
        { name: "used at least one tool", ok: summary.toolCount >= 1 },
        { name: "final says disabled", ok: /disabled|禁用|已禁用/i.test(finalText) },
        { name: "final mentions weekday 9 AM schedule", ok: /weekday|weekdays|周一|周五|9:?00|09:?00/i.test(finalText) },
      ]);
    case "browser-control":
      return validationResult([
        nonEmptyFinal,
        { name: "used at least one tool", ok: summary.toolCount >= 1 },
        { name: "final reports Example Domain title", ok: /Example Domain/i.test(finalText) },
        { name: "final reports main sentence", ok: /This domain is for use|documentation examples/i.test(finalText) },
      ]);
    case "computer-use":
      return validationResult([
        nonEmptyFinal,
        { name: "used computer tools repeatedly enough to inspect AX", ok: summary.toolCount >= 1 },
        { name: "final mentions Calculator", ok: /Calculator|计算器/i.test(finalText) },
        { name: "final includes AX/button evidence", ok: /AXButton|button|按钮/i.test(finalText) },
        { name: "final includes expected controls", ok: /All Clear|Divide|Equals|AC|等号|清除|除/i.test(finalText) },
      ]);
    case "screen-meeting-recall":
      return validationResult([
        nonEmptyFinal,
        { name: "used recall/search tools", ok: summary.toolCount >= 1 },
        { name: "final handles screen or meeting evidence", ok: /screen|meeting|timestamp|屏幕|会议|时间戳|无数据/i.test(finalText) },
      ]);
    default:
      return validationResult([nonEmptyFinal]);
  }
}

async function main() {
  const allCases = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
  const cases = allCases.filter((c) => {
    if (only && !only.has(c.id)) return false;
    return c.runnable || includeGated;
  });
  if (!cases.length) {
    console.error("No cases selected.");
    process.exit(2);
  }

  fs.mkdirSync(WORKSPACES, { recursive: true });
  const results = [];
  console.log(`Running ${cases.length} benchmark case(s) via ${SOCK}`);

  for (const testCase of cases) {
    const started = performance.now();
    process.stdout.write(`\n${testCase.id} ... `);
    let workspace = path.join(WORKSPACES, testCase.id);
    let priorAgentSettings = null;
    try {
      workspace = setupWorkspace(testCase);
      if (testCase.agentSettings) {
        priorAgentSettings = await request("agentSettings");
        await request("agentSettings", { settings: testCase.agentSettings });
      }
      const result = await request("agentPrompt", {
        text: testCase.prompt,
        workspace,
        archive: !keepConversations,
      });
      const summary = summarizeMessages(result.messages);
      const validation = validateCase(testCase, workspace, summary);
      const record = {
        id: testCase.id,
        title: testCase.title,
        category: testCase.category,
        bridgeOk: true,
        passed: validation.passed,
        workspace,
        durationMs: Math.round(performance.now() - started),
        bridgeDurationMs: result.durationMs,
        conversationId: result.conversation?.id,
        successHints: testCase.successHints || [],
        validation,
        ...summary,
      };
      results.push(record);
      console.log(`${record.passed ? "pass" : "FAIL"} ${record.durationMs}ms`);
    } catch (error) {
      const record = {
        id: testCase.id,
        title: testCase.title,
        category: testCase.category,
        bridgeOk: false,
        passed: false,
        workspace,
        durationMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(record);
      console.log(`ERR ${record.error}`);
    } finally {
      if (priorAgentSettings) {
        try {
          await request("agentSettings", { settings: priorAgentSettings });
        } catch {
          /* best-effort restore */
        }
      }
    }
    fs.writeFileSync(RESULTS, JSON.stringify({ ranAt: new Date().toISOString(), host: os.hostname(), results }, null, 2));
  }

  const completed = results.filter((r) => r.bridgeOk).length;
  const passed = results.filter((r) => r.passed).length;
  console.log(`\nWrote ${RESULTS}`);
  console.log(`${completed}/${results.length} bridge runs completed`);
  console.log(`${passed}/${results.length} cases passed validation`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
