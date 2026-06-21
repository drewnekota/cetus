/**
 * cetus skill-discovery — lazy lookup for large skill libraries.
 *
 * pi exposes a small visible skill manifest in the system prompt. Cetus marks
 * overflow skills with `disable-model-invocation: true` so they don't bloat every
 * turn; these tools let the model search and read the frozen per-conversation
 * skill snapshot on demand.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim();
const SKILLS_DIR = AGENT_DIR ? join(AGENT_DIR, "skills") : "";
const SEARCH_LIMIT = 30;
const READ_LIMIT_CHARS = 60_000;

interface SkillEntry {
  id: string;
  name: string;
  description: string;
  filePath: string;
  lazyOnly: boolean;
}

export default function skillDiscovery(pi: ExtensionAPI) {
  if (!SKILLS_DIR) return;

  let cache: SkillEntry[] | null = null;
  const catalog = () => {
    if (!cache) cache = loadCatalog(SKILLS_DIR);
    return cache;
  };

  pi.registerTool({
    name: "skill_search",
    label: "Search skills",
    description:
      "Search the user's frozen skill library by keyword. Use this when no visible " +
      "skill obviously matches, or when the prompt says additional skills are lazy-only. " +
      "Then call skill_read with the returned id/name to load the full SKILL.md.",
    promptSnippet:
      "Additional lazy-only skills may be available. Use skill_search(query) then skill_read(id) when a task may match a skill not listed in <available_skills>.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Keywords to match against skill names/descriptions. Omit to list top skills." })),
      includeVisible: Type.Optional(Type.Boolean({ description: "Include skills already visible in <available_skills> (default false)." })),
    }),
    async execute(_id, params) {
      const p = (params ?? {}) as { query?: string; includeVisible?: boolean };
      return asText(searchSkills(catalog(), p.query, p.includeVisible === true));
    },
  });

  pi.registerTool({
    name: "skill_read",
    label: "Read skill",
    description:
      "Read one skill's SKILL.md from the frozen conversation snapshot. Use after " +
      "skill_search, then follow the skill instructions and resolve relative paths " +
      "against the reported skillDir.",
    parameters: Type.Object({
      id: Type.String({ description: "Skill id or exact skill name from skill_search." }),
    }),
    async execute(_id, params) {
      const wanted = String(((params ?? {}) as { id?: string }).id ?? "").trim();
      const skill = resolveSkill(catalog(), wanted);
      if (!skill) return { content: [{ type: "text" as const, text: `Unknown skill "${wanted}". Use skill_search first.` }], isError: true };
      try {
        const raw = readFileSync(skill.filePath, "utf-8");
        const text = raw.length > READ_LIMIT_CHARS
          ? `${raw.slice(0, READ_LIMIT_CHARS)}\n\n[truncated: ${raw.length - READ_LIMIT_CHARS} chars omitted]`
          : raw;
        return asText(`skillId: ${skill.id}\nskillName: ${skill.name}\nskillDir: ${dirname(skill.filePath)}\n\n${text}`);
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Failed to read skill: ${(err as Error).message}` }], isError: true };
      }
    },
  });
}

function loadCatalog(root: string): SkillEntry[] {
  const out: SkillEntry[] = [];
  if (!existsSync(root)) return out;
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      const filePath = join(dir, "SKILL.md");
      const md = readFileSync(filePath, "utf-8");
      const fm = frontmatter(md);
      if (fm.description) {
        out.push({
          id: basename(dir),
          name: fm.name || basename(dir),
          description: compact(fm.description, 600),
          filePath,
          lazyOnly: fm.disableModelInvocation === true,
        });
      }
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const child = join(dir, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(child).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (isDir && child.startsWith(`${root}${sep}`)) visit(child);
    }
  };
  visit(root);
  return out.sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
}

function searchSkills(skills: SkillEntry[], query?: string, includeVisible = false): string {
  const pool = includeVisible ? skills : skills.filter((s) => s.lazyOnly);
  const q = (query ?? "").toLowerCase().trim();
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
  const scored = pool
    .map((skill) => {
      const hay = `${skill.id} ${skill.name} ${skill.description}`.toLowerCase();
      const score = tokens.length ? tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0) : 1;
      return { skill, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || cmp(a.skill.name, b.skill.name) || cmp(a.skill.id, b.skill.id));
  if (scored.length === 0) return q ? `No lazy-only skills match "${query}".` : "No lazy-only skills available.";
  const shown = scored.slice(0, SEARCH_LIMIT);
  const lines = shown.map(({ skill }) => `- ${skill.id} (${skill.name})${skill.lazyOnly ? " [lazy]" : ""}: ${compact(skill.description, 180)}`);
  const more = scored.length > shown.length ? `\n…and ${scored.length - shown.length} more; narrow your query.` : "";
  return `${scored.length} matching skill(s). Use skill_read({ "id": "..." }) to load one:\n${lines.join("\n")}${more}`;
}

function resolveSkill(skills: SkillEntry[], id: string): SkillEntry | undefined {
  const exact = skills.find((s) => s.id === id || s.name === id || s.filePath === id);
  if (exact) return exact;
  const lower = id.toLowerCase();
  const hits = skills.filter((s) => s.id.toLowerCase() === lower || s.name.toLowerCase() === lower);
  return hits.length === 1 ? hits[0] : undefined;
}

function frontmatter(md: string): { name?: string; description?: string; disableModelInvocation?: boolean } {
  const s = md.trimStart();
  if (!s.startsWith("---")) return {};
  const lines = s.split(/\r?\n/);
  const result: { name?: string; description?: string; disableModelInvocation?: boolean } = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = unquote(line.slice(idx + 1).trim());
    if (key === "name") result.name = value;
    else if (key === "description") result.description = value;
    else if (key === "disable-model-invocation") result.disableModelInvocation = value === "true";
  }
  return result;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function compact(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

const asText = (text: string): any => ({ content: [{ type: "text", text }] });
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
