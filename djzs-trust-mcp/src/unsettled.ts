/**
 * unsettled.ts - which sentence a WAIT is about.
 *
 * A WAIT means the engine could not settle a scored fact from the text. The consensus extraction
 * already keeps all three raw readings (ConsensusExtractionResult.raw). This module re-reads each
 * one through the extraction layer's OWN parser and gates (extractAuditInput with a stub model that
 * returns the stored reading), so the per-reading states here are exactly the ones the merge saw.
 * Nothing under server/ is copied or changed, and nothing here can reach the verdict or its hash:
 * it runs after the verdict exists, on the free route only, and a failure here drops the field
 * instead of failing the response.
 *
 * Per unsettled field:
 *   why        "split"    the readings disagreed (the engine's disagreement entry is the bare field)
 *              "evidence" every reading said missing, but they quoted different text ("<field>(evidence)")
 *              "silent"   no reading could settle it, and none disagreed
 *   states     how many readings ended present / absent / unknown after the gates
 *   sentences  the caller's own sentences the readings pointed at, in text order, with counts
 *
 * Sentences are LOCATED, never written. A reading's quote or value is matched exactly (case and
 * whitespace insensitive, up to three consecutive sentences); a paraphrased value is matched to the
 * one sentence holding most of its words, or to nothing. Only text taken from the intent is returned.
 */
import { extractAuditInput, type ExtractionContext } from "../../server/engine-v2/extraction-layer"

export type UnsettledWhy = "split" | "evidence" | "silent"
export interface UnsettledSentence {
  /** Verbatim from the intent (whitespace collapsed, rendered `key: ` prefix removed, at most MAX_SENTENCE_CHARS). */
  text: string
  /** Readings that found the fact in this sentence. */
  present: number
  /** Readings that quoted this sentence as showing the fact is missing. */
  absent: number
}
export interface UnsettledField {
  field: string
  why: UnsettledWhy
  states: { present: number; absent: number; unknown: number }
  sentences: UnsettledSentence[]
}

export const MAX_SENTENCE_CHARS = 400
/** A text value shorter than this is too generic to place by exact match ("none", "CME"). */
const MIN_EXACT_CHARS = 8
/** Share of a paraphrase's content words that one sentence must hold to be named. */
const FUZZY_MIN_SHARE = 0.6

const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "are", "was", "were", "will", "have", "has", "had", "its", "not", "but",
  "from", "they", "their", "them", "you", "your", "our", "can", "all", "any", "there", "been", "which", "would",
  "could", "should", "than", "then", "when", "what", "into", "about", "before", "after", "over", "under", "also",
  "only", "more", "most", "some", "such", "very", "who", "how", "why", "may", "might", "just", "out", "his", "her",
])

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()
const tokensOf = (s: string) =>
  new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3 && !STOPWORDS.has(t)))
/** A quote as the model emits it: strip wrapping quote marks and trailing punctuation before matching. */
const cleanSnippet = (s: string) =>
  norm(s).replace(/^["'“‘]+/, "").replace(/["'”’.,;:!?]+$/, "").trim()

export interface Sentence {
  start: number
  end: number
  norm: string
  tokens: Set<string>
}

/**
 * Split on newlines and on . ! ? followed by whitespace and a next character that is not a
 * lowercase letter or a digit ("Dec. 9" and "e.g. the" stay whole). Closing quotes and brackets
 * stay with their sentence. Offsets index the original text.
 */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = []
  const push = (s: number, e: number) => {
    while (s < e && /\s/.test(text[s])) s++
    while (e > s && /\s/.test(text[e - 1])) e--
    if (e > s) {
      const t = text.slice(s, e)
      out.push({ start: s, end: e, norm: norm(t), tokens: tokensOf(t) })
    }
  }
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === "\n") {
      push(start, i)
      start = i + 1
      continue
    }
    if (c !== "." && c !== "!" && c !== "?") continue
    let j = i + 1
    while (j < text.length && /[.!?]/.test(text[j])) j++
    while (j < text.length && /["')\]”’]/.test(text[j])) j++
    if (j < text.length && !/\s/.test(text[j])) continue
    let k = j
    while (k < text.length && text[k] !== "\n" && /\s/.test(text[k])) k++
    if (k < text.length && /[a-z0-9]/.test(text[k])) continue
    push(start, j)
    start = j
    i = j - 1
  }
  push(start, text.length)
  return out
}

function range(i: number, w: number): number[] {
  return Array.from({ length: w }, (_, n) => i + n)
}

/** Exact containment, one to three consecutive sentences; the single sentence wins when both match. */
export function locateExact(snippet: string, sents: Sentence[]): number[] | null {
  const q = cleanSnippet(snippet)
  if (q.length < MIN_EXACT_CHARS) return null
  for (let w = 1; w <= 3; w++) {
    for (let i = 0; i + w <= sents.length; i++) {
      const joined = sents.slice(i, i + w).map((s) => s.norm).join(" ")
      if (joined.includes(q)) return range(i, w)
    }
  }
  return null
}

/** A paraphrase: the one sentence holding the largest share (at least FUZZY_MIN_SHARE, two words) of its content words. */
export function locateFuzzy(snippet: string, sents: Sentence[]): number[] | null {
  const q = tokensOf(snippet)
  if (q.size < 2) return null
  let best = -1
  let bestShare = 0
  let bestHits = 0
  sents.forEach((s, i) => {
    let hits = 0
    for (const t of q) if (s.tokens.has(t)) hits++
    const share = hits / q.size
    if (share > bestShare) {
      best = i
      bestShare = share
      bestHits = hits
    }
  })
  return best >= 0 && bestShare >= FUZZY_MIN_SHARE && bestHits >= 2 ? [best] : null
}

/** A stated figure (a stop, a size): the first sentence carrying it. Under three digits is too common to place. */
export function locateNumber(n: number, sents: Sentence[]): number[] | null {
  if (!Number.isFinite(n)) return null
  const s = String(Math.abs(n))
  if (s.replace(/\D/g, "").length < 3) return null
  const re = new RegExp(`(^|[^0-9.])${s.replace(/\./g, "\\.")}(?![0-9])`)
  for (let i = 0; i < sents.length; i++) {
    const plain = sents[i].norm.replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    if (re.test(plain)) return [i]
  }
  return null
}

const NUMERIC = /^\$?\d[\d,]*(\.\d+)?$/

function locateValue(value: unknown, field: string, sents: Sentence[]): number[] | null {
  if (typeof value === "number") return locateNumber(value, sents)
  if (typeof value === "string") {
    const v = value.trim()
    // The vacuous probability_basis ("no probability asserted") names no sentence by definition.
    if (field === "probability_basis" && /\bno (probability|odds|edge)\b/i.test(v)) return null
    if (NUMERIC.test(v)) return locateNumber(Number(v.replace(/[$,]/g, "")), sents)
    return locateExact(v, sents) ?? locateFuzzy(v, sents)
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const at = locateValue(item, field, sents)
      if (at) return at
    }
  }
  return null
}

/** First balanced-looking JSON object in a reading, as the extraction layer finds it. Only used to read an absent's quote. */
function parseReading(raw: string): Record<string, unknown> | null {
  const a = raw.indexOf("{")
  const b = raw.lastIndexOf("}")
  if (a === -1 || b <= a) return null
  try {
    const v: unknown = JSON.parse(raw.slice(a, b + 1))
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function quoteOf(reading: Record<string, unknown> | null, field: string): string | null {
  const f = reading?.[field]
  if (!f || typeof f !== "object") return null
  const q = (f as Record<string, unknown>).quote
  return typeof q === "string" && q.trim() !== "" ? q : null
}

function displayText(text: string, sents: Sentence[], idx: number[], keyPrefixes: readonly string[]): string {
  let t = text.slice(sents[idx[0]].start, sents[idx[idx.length - 1]].end).replace(/\s+/g, " ").trim()
  for (const k of keyPrefixes) {
    if (k && t.startsWith(`${k}: `)) {
      t = t.slice(k.length + 2)
      break
    }
  }
  return t.length > MAX_SENTENCE_CHARS ? `${t.slice(0, MAX_SENTENCE_CHARS - 1).trimEnd()}…` : t
}

export interface ExplainArgs {
  /** The exact text the extraction read (renderIntentText of the intent). */
  text: string
  /** ConsensusExtractionResult.raw: a JSON array of the readings, as returned by the model. */
  raw: string
  /** The engine's unknown_fields, in engine order. */
  unknownFields: readonly string[]
  /** The consensus merge's disagreements: a bare field (state split) or "<field>(evidence)". */
  disagreements: readonly string[]
  /** The extraction context the pipeline used ("perp" for the perp route). Selects the prompt only; the parser is shared. */
  context?: ExtractionContext
  /** Keys of an object intent; their rendered "key: " prefix is removed from the sentence shown. */
  keyPrefixes?: readonly string[]
}

export async function explainUnsettled(args: ExplainArgs): Promise<UnsettledField[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(args.raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed) || args.unknownFields.length === 0) return []
  const readings = await Promise.all(
    parsed.map(async (r) => {
      const raw = typeof r === "string" ? r : ""
      const { input } = await extractAuditInput(args.text, async () => raw, args.context)
      return { input: input as unknown as Record<string, { state?: unknown; value?: unknown }>, json: parseReading(raw) }
    }),
  )
  const sents = splitSentences(args.text)
  const prefixes = args.keyPrefixes ?? []

  return args.unknownFields.map((field): UnsettledField => {
    const why: UnsettledWhy = args.disagreements.includes(`${field}(evidence)`)
      ? "evidence"
      : args.disagreements.includes(field)
        ? "split"
        : "silent"
    const states = { present: 0, absent: 0, unknown: 0 }
    const hits = new Map<string, { idx: number[]; present: number; absent: number }>()
    for (const r of readings) {
      const f = r.input[field]
      const st = f?.state === "present" || f?.state === "absent" ? f.state : "unknown"
      states[st]++
      let at: number[] | null = null
      if (st === "present") at = locateValue(f?.value, field, sents)
      else if (st === "absent") {
        // A surviving absent passed the extraction layer's verbatim gate, so its quote is the caller's text.
        const q = quoteOf(r.json, field)
        at = q ? locateExact(q, sents) : null
      }
      if (!at || st === "unknown") continue
      const key = at.join(",")
      const h = hits.get(key) ?? { idx: at, present: 0, absent: 0 }
      h[st]++
      hits.set(key, h)
    }
    const sentences = [...hits.values()]
      .sort((a, b) => a.idx[0] - b.idx[0])
      .map((h) => ({ text: displayText(args.text, sents, h.idx, prefixes), present: h.present, absent: h.absent }))
    return { field, why, states, sentences }
  })
}
