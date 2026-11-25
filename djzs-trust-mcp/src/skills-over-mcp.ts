/**
 * skills-over-mcp.ts - publishes the server's skills under the Skills over MCP extension
 * (io.modelcontextprotocol/skills, SEP-2640).
 *
 * WHAT IT SERVES. skills/list and skills/get return each skill's frontmatter and its complete file manifest
 * (URI, sha256 digest, byte size). Every file is an ordinary MCP resource read through resources/read at its
 * skill:// URI. The bytes and digests come from skills-bundle.generated.ts, computed from skills/<name>/ on disk,
 * so a host's digest check passes on exactly the bytes this server sends.
 *
 * PROTOCOL REVISION. The extension is specified against MCP 2026-07-28, where a server declares it in
 * server/discover. This server speaks 2025-11-25 and earlier (MCP SDK 1.x), so it declares the extension in the
 * capabilities its initialize result returns, which the 2025-11-25 schema already carries (capabilities.extensions).
 * A client that negotiates skills on a legacy connection finds it there; a client that only does so on 2026-07-28
 * will see it once this server also speaks that revision. The methods and shapes are the same either way.
 * The 2026-07-28 cache fields (resultType, ttlMs, cacheScope) are returned now: extra fields are harmless to a
 * legacy client and required by a modern one.
 *
 * NOTHING HERE CAN TOUCH A VERDICT. It only reads compiled-in text.
 */
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import { SKILLS, type SkillEntry } from "./skills-bundle.generated"

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills"
/** Declared in capabilities.extensions. Empty object: supported, without directory reads. */
export const SKILLS_EXTENSION_SETTINGS = {} as const
/** Listings change only with a deploy; five minutes keeps a long session current without polling. */
export const SKILLS_TTL_MS = 300_000

const SkillsListRequest = z.object({
  method: z.literal("skills/list"),
  params: z.looseObject({ cursor: z.string().optional() }).optional(),
})
const SkillsGetRequest = z.object({
  method: z.literal("skills/get"),
  params: z.looseObject({ uri: z.string() }),
})

/** One skills/list entry: frontmatter unchanged plus the complete manifest. Atomic, never split across pages. */
export function skillEntry(s: SkillEntry) {
  return {
    uri: s.uri,
    frontmatter: s.frontmatter,
    resources: s.files.map((f) => ({ uri: f.uri, digest: `sha256:${f.sha256}`, size: f.size })),
  }
}

export function listSkillsResult() {
  return { resultType: "complete", skills: SKILLS.map(skillEntry), ttlMs: SKILLS_TTL_MS, cacheScope: "public" }
}

/** skills/get by the URI of a SKILL.md. An unknown URI is -32602 (Invalid params), which stops a host's load. */
export function getSkillResult(uri: string) {
  const s = SKILLS.find((x) => x.uri === uri)
  if (!s) throw new McpError(ErrorCode.InvalidParams, "Unknown skill URI")
  return { resultType: "complete", skill: skillEntry(s), ttlMs: SKILLS_TTL_MS, cacheScope: "public" }
}

/**
 * Register every skill file as a resource and install skills/list + skills/get. Call once per server, before
 * connect. registerResource also declares the resources capability, which the extension requires.
 */
export function registerSkills(server: McpServer): void {
  for (const s of SKILLS) {
    for (const f of s.files) {
      server.registerResource(
        `${s.name}/${f.path}`,
        f.uri,
        {
          title: f.path === "SKILL.md" ? `Skill: ${s.name}` : `${s.name}: ${f.path}`,
          description: f.path === "SKILL.md"
            ? `Agent Skill (Skills over MCP). ${String(s.frontmatter.description ?? "")}`.slice(0, 500)
            : `Supporting file of the ${s.name} skill.`,
          mimeType: f.mimeType,
          size: f.size,
        },
        async () => ({ contents: [{ uri: f.uri, mimeType: f.mimeType, text: f.text }] }),
      )
    }
  }
  server.server.setRequestHandler(SkillsListRequest, async () => listSkillsResult() as never)
  server.server.setRequestHandler(SkillsGetRequest, async (req) => getSkillResult(req.params.uri) as never)
}
