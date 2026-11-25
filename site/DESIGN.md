DJZS DESIGN SYSTEM — TERMINAL BRUTALISM. The interface is an audit terminal:
every verdict computed, not improvised. Design like a machine that shows its work.
IDENTITY
- Mark: ">_" terminal prompt. Wordmark: "DJZS" or "djzs.ai", always monospace.
- Doctrine lines (use as real copy, never paraphrase into marketing-speak):
  "Audit before act." · "No agent acts without audit." ·
  "Verdict is computed, not improvised." · "Abstain over guess." ·
  "Evidence before record."
COLOR — semantic only; nothing decorative gets color
- Canvas: #0A0A0A near-black. Panels: #111113. Rules/borders: 1px #26262B.
- Text: #E7E7EA primary, #8A8A93 secondary, monospace throughout.
- PASS green #3DFF88 · WAIT amber #FFB000 · FAIL red #FF4D4D — verdict states (phosphor trio, brand patch 2026-07-17)
  are the ONLY saturated colors in any composition.
- Chain accent: Base blue #0052FF, LOGOMARK-ONLY (brand patch 2026-07-17; supersedes the
  earlier links ruling).
- Color rule (2026-11-24; supersedes "links are phosphor green"): saturated color marks a verdict
  (PASS/WAIT/FAIL, an OK/XX status row) or the ONE thing to press on a screen (solid PASS-green
  button). Everything else is neutral: links off-white #E6E6E6 underlined in #4a4a4a; chips and
  pickers neutral until selected (selected = inverse, off-white fill); tabs underline the open
  one, no fill; prices, bullets, card headings and section numbers in text or muted. When
  everything is green, PASS stops meaning anything.
- Borders mean something: inputs, buttons and verdict frames carry them. Other groups are
  separated by space and one thin rule, not nested boxes.
- Brand layer: static scanline overlay, canonical 3.5% green at 4px pitch, non-interactive;
  footer transmission row ("END_TRANSMISSION. // djzs.ai" — product surfaces carry djzs.ai,
  not ENS, per the opsec convention).
- Logo (2026-07-17; full-bleed tile 2026-11-21): phosphor `>_` prompt mark on a full-bleed
  #1C1C20 square. Vector master favicon.svg is the single source; favicon-32/180/512.png and
  favicon.ico (16/32/48) are rasterized from it with rsvg-convert, every pixel opaque. Full
  bleed because Safari draws a light tile behind tab icons, which showed through the old
  disk's transparent corners as a white border. Serves as favicon AND the header corner mark;
  the header clips it to a disk (border-radius 50%), so the header looks as it did. Replaces
  the old CSS `>_ ` ::before prompt. Header = [logo] DJZS. When the icon changes, bump the
  ?v= on the icon <link> tags (404, guide, index, legal): browsers hold icons for days.
- Brutalism layer (2026-07-17): prompt-path row on every page (~/djzs/<page> $ + cursor);
  per-page boot-status boards (guide MODE/PRICE, legal DISCLOSURE/SCOPE, 404 red ERR row);
  phosphor ::selection and scrollbars; links underlined, hover brightens the underline (2026-11-24);
  guide steps numbered (// step 01..03), legal sections numbered (// 01..06); em-scaled
  blinking cursor honoring prefers-reduced-motion; thead blocks on panel.
TYPE
- Monospace-only: JetBrains Mono for EVERYTHING — headers, labels, numbers, buttons,
  AND long body paragraphs. ALL-CAPS micro-labels with wide tracking. Uniform mono
  surface matching the DST reference (deterministic-simulation.com). No serifs, no
  sans body, no display fonts.
STRUCTURE & TEXTURE
- Grid-strict, dense but ordered. Sharp corners (0–2px radius). Flat: no gradients,
  no glass, no shadows deeper than a 1px border.
- Signature elements: "// ─────" section dividers · status-line rows
  (OK / XX prefixes, [tags]) · truncated hashes as texture (0x7f3a…e9c2) ·
  JSON Proof-of-Logic certificate blocks rendered as designed objects with
  syntax color · blinking-cursor accents.
- Data over decoration: tables, ledgers, verdict stamps. Numbers are the imagery.
MOTION
- Minimal and mechanical: type-in reveals, cursor blink, a verdict "stamping" in.
  Linear/instant easing. Nothing bouncy, nothing floaty.
NEVER
- No gradients, glassmorphism, pastels, rounded-friendly SaaS cards, stock photos,
  3D blobs, emoji, mascots, drop shadows, or filler copy. If an element isn't
  evidence, a verdict, or a control — delete it.
