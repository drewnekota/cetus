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
const RESULTS_DIR = path.join(HERE, "results");
const SOCK = process.env.CETUS_DEVTEST_SOCK || "/tmp/cetus-devtest.sock";
const REQUEST_TIMEOUT_MS = Number(process.env.CETUS_BENCH_TIMEOUT_MS || 900_000);

const args = parseArgs(process.argv.slice(2));
const only = args.only ? new Set(String(args.only).split(",").filter(Boolean)) : null;
const includeGated = Boolean(args["include-gated"]);
const setupOnly = Boolean(args["setup-only"]);
const validateOnly = Boolean(args["validate-only"]);
const keepConversations = Boolean(args["keep-conversations"]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function rmrf(file) {
  fs.rmSync(file, { recursive: true, force: true });
}

function copyDir(from, to) {
  rmrf(to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

function walkFiles(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(file));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

function snapshotFiles(root) {
  const snapshot = {};
  if (!fs.existsSync(root)) return snapshot;
  for (const file of walkFiles(root)) {
    const rel = path.relative(root, file);
    snapshot[rel] = fs.readFileSync(file, "utf8");
  }
  return snapshot;
}

function setupWorkspace(testCase) {
  const fixture = path.join(HERE, testCase.fixtureDir);
  const workspace = path.join(WORKSPACES, testCase.id);
  copyDir(fixture, workspace);
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
  const toolCount = messages.filter((m) => String(m?.role || "").includes("tool")).length;
  const allText = messages.map(textFromMessage).join("\n");
  return {
    messageCount: messages.length,
    toolCount,
    finalAssistantText: textFromMessage(assistant).slice(0, 8000),
    transcriptText: allText.slice(0, 30000),
  };
}

function runCommand(workspace, command, commandArgs = []) {
  const res = spawnSync(command, commandArgs, {
    cwd: workspace,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: (res.stdout || "").trim().slice(0, 4000),
    stderr: (res.stderr || "").trim().slice(0, 4000),
  };
}

function fileText(workspace, rel) {
  const file = path.join(workspace, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function exists(workspace, rel) {
  return fs.existsSync(path.join(workspace, rel));
}

function check(name, ok, details = undefined) {
  return { name, ok: Boolean(ok), ...(details === undefined ? {} : { details }) };
}

function result(checks) {
  return { passed: checks.every((item) => item.ok), checks };
}

function includes(text, needle) {
  return text.toLowerCase().includes(String(needle).toLowerCase());
}

function includesAny(text, needles) {
  return needles.some((needle) => includes(text, needle));
}

function includesAll(text, needles) {
  return needles.every((needle) => includes(text, needle));
}

function parseMoneyNumbers(text) {
  return [...text.matchAll(/(?:\$|USD\s*)?([0-9][0-9,]*(?:\.[0-9]+)?)/gi)]
    .map((m) => Number(m[1].replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
}

function hasNearNumber(text, target, tolerancePct = 1) {
  const tolerance = Math.abs(target) * (tolerancePct / 100);
  return parseMoneyNumbers(text).some((n) => Math.abs(n - target) <= tolerance);
}

function validateCase(testCase, workspace, summary, beforeSnapshot) {
  const expected = readJson(path.join(workspace, "expected.json"));
  const finalText = summary.finalAssistantText || "";
  const transcript = [summary.transcriptText, finalText].join("\n");
  const nonEmptyFinal = check("final assistant text is non-empty", finalText.trim().length >= 30);

  switch (testCase.id) {
    case "repair-regression-with-minimal-diff": {
      const test = runCommand(workspace, expected.testCommand[0], expected.testCommand.slice(1));
      const beforeTest = beforeSnapshot["test/invoice.test.js"] || "";
      const afterTest = fileText(workspace, "test/invoice.test.js");
      const combined = [summary.transcriptText, finalText].join("\n");
      return result([
        nonEmptyFinal,
        check("npm test exits 0", test.ok, test),
        check("src/currency.js unchanged", fileText(workspace, "src/currency.js") === beforeSnapshot["src/currency.js"]),
        check("test file added or strengthened", afterTest.length > beforeTest.length || includesAny(afterTest, expected.edgeCasesToCover)),
        check("transcript includes root cause", /percent|percentage|百分比|固定金额|dollar amount|折扣/i.test(combined)),
        check("final includes verification command", /npm test|node --test/i.test(finalText)),
      ]);
    }
    case "unsafe-migration-review": {
      const after = snapshotFiles(workspace);
      const unchanged = expected.mustNotEdit.every((rel) => after[rel] === beforeSnapshot[rel]);
      const combined = [summary.transcriptText, finalText].join("\n");
      return result([
        nonEmptyFinal,
        check("workspace files unchanged", unchanged),
        check("mentions destructive migration/data loss", /drop table|data loss|数据丢失|删除表/i.test(combined)),
        check("mentions SQL injection", /sql injection|注入/i.test(combined)),
        check("mentions missing transaction/non-atomic update", /transaction|atomic|事务|原子/i.test(combined)),
        check("mentions non-idempotent duplicate invoice risk", /idempot|duplicate|重复|重试|invoice/i.test(combined)),
        check("includes file/line references", /:\d+|line \d+|第\s*\d+\s*行|L\d+/i.test(combined)),
      ]);
    }
    case "messy-data-exec-brief": {
      const brief = fileText(workspace, "brief.md");
      const cleaned = fileText(workspace, "cleaned_orders.csv");
      const combined = [brief, fileText(workspace, "analysis.js"), finalText].join("\n");
      return result([
        nonEmptyFinal,
        check("creates analysis.js", exists(workspace, "analysis.js")),
        check("creates brief.md", exists(workspace, "brief.md")),
        check("creates cleaned_orders.csv", exists(workspace, "cleaned_orders.csv")),
        check("net revenue is within 1 percent", hasNearNumber(combined, expected.expectedMetrics.netRevenueUsd, 1)),
        check("May net revenue is within 1 percent", hasNearNumber(combined, expected.expectedMetrics.mayNetRevenueUsd, 1)),
        check("June net revenue is within 1 percent", hasNearNumber(combined, expected.expectedMetrics.juneNetRevenueUsd, 1)),
        check("mentions duplicate order and unknown channel", includesAll(combined, ["1003", "unknown"])),
        check("mentions anomalies", expected.expectedMetrics.anomalyOrderIds.every((id) => includes(combined, id))),
        check("cleaned csv has no duplicate 1003 paid row", (cleaned.match(/^1003,/gm) || []).length <= 1),
      ]);
    }
    case "current-docs-with-source-conflict": {
      const output = fileText(workspace, expected.requiredOutput);
      const combined = [output, finalText].join("\n");
      const sourceLinks = (combined.match(/https:\/\/[^\s)]+/g) || []).length;
      return result([
        nonEmptyFinal,
        check(`${expected.requiredOutput} exists`, exists(workspace, expected.requiredOutput)),
        check("mentions at least three source links", sourceLinks >= 3),
        check("identifies stale third-party source", /stale|过期|third.party|第三方|lower confidence|低置信/i.test(combined)),
        check("produces capability matrix", /\|.*\|.*\||matrix|矩阵/i.test(combined)),
        check("separates official fact from local inference", /official|官方|inferred|推断|local repo|本地/i.test(combined)),
        check("covers expected capabilities", expected.capabilitiesToCover.filter((cap) => includes(combined, cap)).length >= 6),
      ]);
    }
    case "offline-board-artifact": {
      const html = fileText(workspace, expected.requiredOutput);
      const lowerHtml = html.toLowerCase();
      const forbidden = expected.forbiddenPatterns.filter((pattern) => lowerHtml.includes(pattern.toLowerCase()));
      return result([
        nonEmptyFinal,
        check("index.html exists", exists(workspace, expected.requiredOutput)),
        check("index.html is self-contained HTML", /<html[\s>]/i.test(html) && forbidden.length === 0, { forbidden }),
        check("contains at least two visualization primitives", ((html.match(/<svg|<canvas|chart|bar|line|sparkline/gi) || []).length >= 2)),
        check("contains a detail table", /<table|role=["']table/i.test(html)),
        check("contains filter control", /filter|select|segment|筛选/i.test(html)),
        check("contains print styles", /@media\s+print/i.test(html)),
        check("contains expected totals or source data", hasNearNumber(html, expected.expectedTotals.totalRevenue, 1) || includes(html, "330000")),
      ]);
    }
    case "bridge-permission-recovery": {
      const logText = fileText(workspace, expected.requiredOutput);
      const combined = [logText, finalText, transcript].join("\n");
      return result([
        nonEmptyFinal,
        check(`${expected.requiredOutput} exists`, exists(workspace, expected.requiredOutput)),
        check("records original, disabled, enabled, restored settings", expected.mustRecord.every((key) => includes(combined, key))),
        check("disabled attempt does not claim success", /unavailable|disabled|permission|权限|不可用/i.test(combined)),
        check("enabled attempt has tool evidence", /tool|browser|computer|工具/i.test(combined)),
        check("records settings restoration status", /restore|restored|恢复|restoredSettings/i.test(combined)),
      ]);
    }
    case "visible-browser-form-inspection": {
      const output = fileText(workspace, expected.requiredOutput);
      const combined = [output, finalText, transcript].join("\n");
      return result([
        nonEmptyFinal,
        check(`${expected.requiredOutput} exists`, exists(workspace, expected.requiredOutput)),
        check("reports all required field names", expected.requiredFields.every((field) => includes(combined, field.name))),
        check("reports aria labels", expected.requiredFields.filter((field) => field.ariaLabel).every((field) => includes(combined, field.ariaLabel))),
        check("reports required/default values", includesAll(combined, ["buyer@example.test", "Northstar Labs", "12", "annual"])),
        check("does not describe forbidden mutation", !/submitted|clicked submit|typed|changed value|已提交|点击提交/i.test(combined)),
      ]);
    }
    case "calculator-nonintrusive-ax-audit": {
      const output = fileText(workspace, expected.requiredOutput);
      const combined = [output, finalText, transcript].join("\n");
      const controlHits = expected.mustMention.filter((term) => includes(combined, term)).length;
      const performedForbiddenAction =
        /\b(clicked|typed|moved|activated)\b|brought .*front|bring .*front|我(?:点击|输入|聚焦|移动)|已(?:点击|输入|聚焦|移动)|执行了(?:点击|输入|聚焦|移动)/i.test(
          [output, finalText].join("\n"),
        );
      return result([
        nonEmptyFinal,
        check(`${expected.requiredOutput} exists`, exists(workspace, expected.requiredOutput)),
        check("mentions required calculator controls", controlHits >= expected.mustMention.length - 1),
        check("reports at least 12 controls", (combined.match(/AX[A-Za-z]+|button|按钮|role/gi) || []).length >= expected.minimumControls),
        check("does not report forbidden actions as performed", !performedForbiddenAction),
      ]);
    }
    case "memory-automation-combined": {
      const output = fileText(workspace, expected.requiredOutput);
      const combined = [output, finalText, transcript].join("\n");
      return result([
        nonEmptyFinal,
        check(`${expected.requiredOutput} exists`, exists(workspace, expected.requiredOutput)),
        check("mentions required memory preference", includesAll(combined, ["中文", "结论", "证据"])),
        check("mentions disabled weekly Monday 9 automation", /disabled|禁用/i.test(combined) && /Monday|周一|MO/i.test(combined) && /9:?00|09:?00/i.test(combined)),
        check("does not silently modify existing enabled automation", includes(combined, expected.mustNotSilentlyModifyAutomationId) || /existing|已有|不修改|conflict/i.test(combined)),
        check("explains management controls", /settings|manage|设置|管理/i.test(combined)),
      ]);
    }
    case "local-context-triangulation": {
      const output = fileText(workspace, expected.requiredOutput);
      const combined = [output, finalText, transcript].join("\n");
      return result([
        nonEmptyFinal,
        check(`${expected.requiredOutput} exists`, exists(workspace, expected.requiredOutput)),
        check("identifies final decision date", includes(combined, expected.finalDecision.date)),
        check("cites final decision timestamp or meeting", includes(combined, expected.finalDecision.timestamp) || includes(combined, expected.finalDecision.source)),
        check("distinguishes superseded and contingency dates", includes(combined, expected.supersededDate) && includes(combined, expected.contingencyDate)),
        check("uses at least three source types/events", ["screen", "meeting", "document"].filter((term) => includes(combined, term)).length >= expected.minimumSources),
        check("states uncertainty/confidence", /confidence|uncertain|不确定|置信|evidence|证据/i.test(combined)),
      ]);
    }
    default:
      return result([nonEmptyFinal]);
  }
}

function previousSummaryFor(caseId) {
  if (!fs.existsSync(RESULTS_DIR)) return null;
  const files = fs
    .readdirSync(RESULTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(RESULTS_DIR, name))
    .filter((file) => fs.statSync(file).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  for (const file of files) {
    try {
      const report = readJson(file);
      const match = report.results?.find((item) => item.id === caseId);
      if (match?.summary?.finalAssistantText || match?.summary?.transcriptText) {
        return match.summary;
      }
    } catch {
      /* ignore corrupt partial result files */
    }
  }
  return null;
}

function selectedCases() {
  const allCases = readJson(CASES_PATH);
  return allCases.filter((testCase) => {
    if (only && !only.has(testCase.id)) return false;
    return testCase.runnable || includeGated;
  });
}

async function runCase(testCase) {
  const fixture = path.join(HERE, testCase.fixtureDir);
  const workspace = path.join(WORKSPACES, testCase.id);
  const beforeSnapshot = snapshotFiles(fixture);
  if (!validateOnly) {
    setupWorkspace(testCase);
  }
  if (setupOnly) {
    return {
      id: testCase.id,
      workspace,
      setupOnly: true,
      validation: result([check("workspace created", fs.existsSync(workspace))]),
    };
  }

  let bridgeOk = false;
  let bridgeError = null;
  let agent = null;
  let summary = { messageCount: 0, toolCount: 0, finalAssistantText: "", transcriptText: "" };
  let priorAgentSettings = null;

  if (validateOnly) {
    summary = previousSummaryFor(testCase.id) || summary;
  } else {
    try {
      if (testCase.agentSettings) {
        priorAgentSettings = await request("agentSettings");
        await request("agentSettings", { settings: testCase.agentSettings });
      }
      agent = await request("agentPrompt", {
        text: testCase.prompt,
        workspace,
        archive: !keepConversations,
      });
      bridgeOk = true;
      summary = summarizeMessages(agent?.messages || []);
    } catch (error) {
      bridgeError = String(error?.message || error);
    } finally {
      if (priorAgentSettings) {
        try {
          await request("agentSettings", { settings: priorAgentSettings });
        } catch {
          /* best-effort restore */
        }
      }
    }
  }

  const validation = validateCase(testCase, workspace, summary, beforeSnapshot);
  return {
    id: testCase.id,
    category: testCase.category,
    runnable: testCase.runnable,
    workspace,
    bridgeOk,
    bridgeError,
    summary,
    validation,
    passed: (validateOnly || bridgeOk) && validation.passed,
  };
}

async function main() {
  const cases = selectedCases();
  if (cases.length === 0) {
    console.error("No cases selected.");
    process.exit(1);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultFile = path.join(RESULTS_DIR, `${stamp}.json`);
  const latestFile = path.join(RESULTS_DIR, "latest.json");

  const results = [];
  for (const testCase of cases) {
    process.stdout.write(`\n== ${testCase.id} ==\n`);
    const caseResult = await runCase(testCase);
    results.push(caseResult);
    const passed = caseResult.passed || (setupOnly && caseResult.validation.passed);
    process.stdout.write(`${passed ? "PASS" : "FAIL"} ${testCase.id}\n`);
    for (const item of caseResult.validation.checks) {
      process.stdout.write(`  ${item.ok ? "✓" : "✗"} ${item.name}\n`);
    }
    if (caseResult.bridgeError) {
      process.stdout.write(`  bridge error: ${caseResult.bridgeError}\n`);
    }
  }

  const report = {
    createdAt: new Date().toISOString(),
    hostname: os.hostname(),
    setupOnly,
    validateOnly,
    includeGated,
    selected: cases.map((testCase) => testCase.id),
    results,
  };
  writeJson(resultFile, report);
  writeJson(latestFile, report);

  const passed = results.filter((item) => item.passed || (setupOnly && item.validation.passed)).length;
  process.stdout.write(`\n${passed}/${results.length} cases passed\n`);
  process.stdout.write(`results: ${path.relative(process.cwd(), resultFile)}\n`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
