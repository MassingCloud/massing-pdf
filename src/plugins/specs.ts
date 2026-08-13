/**
 * The specifications workspace.
 *
 * Most drawing viewers treat specs as an attachment — a PDF you can open, scroll, and not much
 * else. But field coordination lives in the specs: a note on a drawing saying "firestop per spec"
 * is only actionable if you can get to 07 84 00 and read what it actually requires.
 *
 * This parses a CSI-formatted spec book into addressable sections and clauses, so a markup can cite
 * `07 84 00 §3.1.A` as a *link* rather than as a string somebody typed, and so the submittal
 * requirements buried in Part 1 can be pulled out into a checklist.
 */
import { definePlugin } from "../core/plugin";
import { activate, refreshRovingTabstops, rovingFocus } from "../core/a11y";
import { splitWords, unionBox, type Word } from "../core/textLayer";
import type { Box } from "../core/types";
import type { Viewer } from "../core/viewer";

/** One clause within a section — the citable unit. */
export interface SpecClause {
  /** Dotted reference within the section, e.g. `3.1.A`. */
  ref: string;
  /** Nesting depth: PART = 0, article = 1, paragraph = 2, subparagraph = 3. */
  depth: number;
  text: string;
  page: number;
  box: Box;
}

export interface SpecSection {
  /** Normalised CSI number, spaced: `07 84 00`. */
  number: string;
  title: string;
  page: number;
  /** Where the heading line sits. Absent on host-supplied sections, which have no line. */
  box?: Box;
  /** Division number derived from the section, e.g. `07`. */
  division: string;
  clauses: SpecClause[];
}

/** A requirement extracted from a section — the thing somebody has to actually do. */
export interface SpecRequirement {
  section: string;
  clause: string;
  kind: "submittal" | "quality" | "warranty" | "closeout" | "other";
  text: string;
  page: number;
}

export interface SpecsOptions {
  /** Supply sections from the host instead of parsing — a project with a spec register should win. */
  sections?: (viewer: Viewer) => Promise<SpecSection[]>;
  /** Skip scanning the drawings for callouts naming a section. */
  scanReferences?: boolean;
  side?: "left" | "right";
  /** Skip parsing entirely (this document is a drawing set, not a spec book). */
  parse?: boolean;
  /**
   * Corrections a user made previously. Without this they last only as long as the session, which
   * makes fixing a mis-parsed spec book a chore somebody has to repeat on every reload.
   *
   * The library does not choose where these live — a host that already stores project settings
   * should keep them next to those, keyed by document.
   */
  corrections?: (viewer: Viewer) => Promise<SpecCorrection[]> | SpecCorrection[];
  /**
   * Called with the *whole* set after any change, so persisting is one write of one array rather
   * than a diff the host has to apply.
   */
  onCorrect?: (corrections: SpecCorrection[], viewer: Viewer) => void | Promise<void>;
  /** Prompt for free text. Defaults to `window.prompt`. */
  promptText?: (title: string, initial?: string) => Promise<string | null>;
}

// `SECTION 07 84 00 — FIRESTOPPING`, `07 84 00 FIRESTOPPING`, `078400 FIRESTOPPING`
const SECTION_HEADING = /^(?:SECTION\s+)?(\d{2})\s?(\d{2})\s?(\d{2}(?:\.\d{2})?)\s*[-–—:]?\s*(.{0,80})$/i;
// `PART 1 - GENERAL`
const PART_HEADING = /^PART\s+(\d)\s*[-–—:]?\s*(.{0,60})$/i;
// `1.1`, `2.03` — an article
const ARTICLE = /^(\d{1,2})\.(\d{1,2})\s+(.{0,120})$/;
// `A.`, `B.` — a paragraph
const PARAGRAPH = /^([A-Z])\.\s+(.{0,200})$/;
// `1.`, `2.` — a subparagraph
const SUBPARAGRAPH = /^(\d{1,2})\.\s+(.{0,200})$/;

/**
 * Spec language is inflected — "Qualifications", "complying", "certified" — so these match on word
 * *stems* with a trailing `\w*` rather than on whole words. A `\b`-terminated stem like `\bqualif\b`
 * matches nothing at all, which is the sort of bug that silently empties a checklist.
 */
const REQUIREMENT_PATTERNS: [RegExp, SpecRequirement["kind"]][] = [
  [/\b(?:submit\w*|shop\s+drawings?|product\s+data|samples?|mock-?ups?)\b/i, "submittal"],
  [/\b(?:test\w*|inspect\w*|certif\w*|qualif\w*|compl(?:y|ies|ying|iance|iant)\w*|conform\w*)\b/i, "quality"],
  [/\b(?:warrant\w*|guarantee\w*)\b/i, "warranty"],
  [/\b(?:closeout|record\s+documents?|as-?builts?|o&m|operation\s+and\s+maintenance|training)\b/i, "closeout"],
];

/**
 * Group a page's words into lines, so headings can be matched against whole lines rather than
 * against the arbitrary text runs pdf.js reports.
 */
async function pageLines(viewer: Viewer, page: number): Promise<{ text: string; box: Box }[]> {
  // Through the kernel, so a scanned spec book served by OCR parses the same way.
  const words = splitWords(await viewer.pageText(page));
  if (!words.length) return [];
  const sorted = [...words].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: { words: typeof words; y: number }[] = [];
  for (const w of sorted) {
    const last = lines[lines.length - 1];
    // Same line when the vertical centres are within half a line height.
    if (last && Math.abs(w.y + w.h / 2 - (last.y)) < w.h * 0.6) {
      last.words.push(w);
      last.y = (last.y * (last.words.length - 1) + (w.y + w.h / 2)) / last.words.length;
    } else {
      lines.push({ words: [w], y: w.y + w.h / 2 });
    }
  }
  return lines.map((l) => ({
    text: l.words.sort((a, b) => a.x - b.x).map((w) => w.str).join(" ").replace(/\s+/g, " ").trim(),
    box: unionBox(l.words),
  }));
}

/** A line of a spec book, with where it sits. The unit `parseSpecLines` works in. */
export interface SpecLine { text: string; box: Box; page: number }

/**
 * A human overriding the parser on one line.
 *
 * The heuristics below are forgiving on purpose, and forgiving means wrong sometimes. Without a way
 * to say so, a spec book whose headings do not match — an office that writes `SECTION 078400`, a
 * scan whose OCR drops the spaces — is not a nuisance but a dead end: you cannot navigate to a
 * section the parser never found.
 *
 * A correction is addressed by page and line *text* rather than by index or coordinates. Text is
 * what the person actually pointed at, and it survives what an index does not — re-parsing, a
 * different zoom, OCR re-running with different boxes. It does not survive the text itself changing,
 * which is the honest limit: a correction made against one OCR pass may not apply to the next.
 */
export interface SpecCorrection {
  page: number;
  /** The line's text as the parser saw it. Matched whitespace-normalised and case-insensitively. */
  text: string;
  /** What the line really is. `none` drops a false positive. */
  as: "section" | "clause" | "none";
  /** For `section` — the CSI number, when the line does not yield one (`07 84 00`). */
  number?: string;
  /** For `section` — the title, when the line does not yield one. */
  title?: string;
  /** For `clause` — PART = 0, article = 1, paragraph = 2, subparagraph = 3. Defaults to 1. */
  depth?: number;
  /** For `clause` — the dotted ref, when it should not be read off the line. */
  ref?: string;
}

/** The key a correction is matched on. Whitespace-normalised and lowercased. */
const correctionKey = (page: number, text: string): string =>
  `${page}:${text.replace(/\s+/g, " ").trim().toLowerCase()}`;

/** `07 84 00` out of `SECTION 078400 — FIRESTOPPING`, more leniently than `SECTION_HEADING`. */
function looseSectionNumber(text: string): string | undefined {
  const m = /(\d{2})\s?(\d{2})\s?(\d{2}(?:\.\d{2})?)/.exec(text);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : undefined;
}

/**
 * A ref for a clause the parser did not recognise as one.
 *
 * Prefers whatever the line declares: a correction almost always means "this *is* an article",
 * not "this article is numbered differently than it says". Only when the line carries no number at
 * all does this fall back to position, which at least keeps refs unique and ordered.
 */
function forcedRef(depth: number, text: string, section: SpecSection, article: string): string {
  const sibling = (d: number) => section.clauses.filter((c) => c.depth === d).length + 1;
  if (depth === 0) {
    const m = /^PART\s+(\d)/i.exec(text);
    return `PART ${m?.[1] ?? sibling(0)}`;
  }
  if (depth === 1) {
    const m = /^(\d{1,2})\.(\d{1,2})/.exec(text);
    return m ? `${m[1]}.${m[2]}` : `${section.clauses.filter((c) => c.depth === 0).length || 1}.${sibling(1)}`;
  }
  const parent = section.clauses.filter((c) => c.depth === depth - 1).pop();
  // A paragraph under no article, or a subparagraph under no paragraph, has nothing to extend. The
  // ref still has to be unique, so it stands alone rather than being silently dropped.
  const base = depth === 2 ? article || parent?.ref : parent?.ref;
  if (depth === 2) {
    const m = /^([A-Z])[.)]/.exec(text);
    const letter = m?.[1] ?? String.fromCharCode(64 + Math.min(sibling(2), 26));
    return base ? `${base}.${letter}` : letter;
  }
  const m = /^(\d{1,2})[.)]/.exec(text);
  const n = m?.[1] ?? String(sibling(3));
  return base ? `${base}.${n}` : n;
}

/**
 * Parse spec lines into sections and clauses.
 *
 * Deliberately heuristic and forgiving: spec formatting varies enough between offices that anything
 * stricter would fail on half of real projects. A section with no recognisable clauses is still
 * returned — being able to jump to `07 84 00` is most of the value even without clause anchors.
 *
 * Kept free of pdf.js so the heuristics can be exercised directly against sample text.
 *
 * `corrections` override the heuristics line by line. They are applied *before* the length and
 * emptiness guards, so a person can classify a line the parser would not have looked at — which is
 * most of the point, since the lines that need correcting are the ones it got wrong.
 */
export function parseSpecLines(
  lines: readonly SpecLine[],
  corrections: readonly SpecCorrection[] = [],
): SpecSection[] {
  const sections: SpecSection[] = [];
  let current: SpecSection | null = null;
  let article = "";

  const overrides = new Map<string, SpecCorrection>();
  for (const c of corrections) overrides.set(correctionKey(c.page, c.text), c);

  for (const line of lines) {
    const { text, page } = line;

    const override = overrides.size ? overrides.get(correctionKey(page, text)) : undefined;
    if (override) {
      if (override.as === "none") continue;
      if (override.as === "section") {
        // Normalise whatever was supplied rather than trusting it. A correction arrives from host
        // storage, so `number` is as untrusted as any other stored field — and an unnormalised one
        // lands in the register as a section no drawing callout can ever match, with `division`
        // sliced out of the first two characters of whatever it happened to be.
        const number = (override.number ? looseSectionNumber(override.number) : undefined)
          ?? looseSectionNumber(text);
        // Without a number there is no section to address, and inventing one would put an entry in
        // the register that no drawing can ever cite. Fall through to the heuristics instead.
        if (number) {
          current = {
            number,
            // Strip positionally rather than by building a pattern out of the number: a RegExp
            // compiled from record data is an injection waiting to happen, and `String.replace`
            // with a string argument matches literally, so the escaped form would never match.
            title: (override.title ?? text
              .replace(/^\s*SECTION\s+/i, "")
              .replace(/^[\d\s.]+/, "")
              .replace(/^[-–—:]\s*/, "")
              .trim()) || number,
            page,
            box: line.box,
            division: number.slice(0, 2),
            clauses: [],
          };
          sections.push(current);
          article = "";
          continue;
        }
      } else if (current) {
        const depth = Math.min(Math.max(override.depth ?? 1, 0), 3);
        const ref = override.ref ?? forcedRef(depth, text, current, article);
        if (depth === 1) article = ref;
        current.clauses.push({ ref, depth, text: text.trim(), page, box: line.box });
        continue;
      }
      // A clause correction before any section has been found has nowhere to attach. Falling
      // through lets the heuristics still see the line rather than dropping it silently.
    }

    if (!text || text.length > 220) continue;

    const sec = SECTION_HEADING.exec(text);
    // Guard against matching a stray dimension string: a real section heading has a title.
    if (sec && sec[4] && /[A-Za-z]{3}/.test(sec[4])) {
      const number = `${sec[1]} ${sec[2]} ${sec[3]}`;
      current = {
        number,
        title: sec[4].trim().replace(/\.+$/, ""),
        page,
        box: line.box,
        division: sec[1]!,
        clauses: [],
      };
      sections.push(current);
      article = "";
      continue;
    }
    if (!current) continue;

    const partM = PART_HEADING.exec(text);
    if (partM) {
      // Scoped here deliberately: an article's ref already carries its part number (`3.1`), so
      // nothing downstream needs to remember which PART we are inside.
      const part = partM[1]!;
      article = "";
      current.clauses.push({ ref: `PART ${part}`, depth: 0, text: partM[2]?.trim() || `PART ${part}`, page, box: line.box });
      continue;
    }

    const art = ARTICLE.exec(text);
    if (art) {
      article = `${art[1]}.${art[2]}`;
      current.clauses.push({ ref: article, depth: 1, text: art[3]!.trim(), page, box: line.box });
      continue;
    }

    const para = PARAGRAPH.exec(text);
    if (para && article) {
      current.clauses.push({ ref: `${article}.${para[1]}`, depth: 2, text: para[2]!.trim(), page, box: line.box });
      continue;
    }

    const sub = SUBPARAGRAPH.exec(text);
    if (sub && article) {
      // A subparagraph belongs to the paragraph above it, so its ref extends that one.
      const parent = current.clauses.filter((c) => c.depth === 2).pop();
      if (parent) {
        current.clauses.push({ ref: `${parent.ref}.${sub[1]}`, depth: 3, text: sub[2]!.trim(), page, box: line.box });
      }
    }
  }
  return sections;
}

/**
 * Read every line of the open document, in order.
 *
 * Separate from {@link parseSpecs} because reading is the expensive half — it pulls text for every
 * page — while parsing is pure and instant. Holding the lines lets a correction re-parse the whole
 * book immediately instead of re-reading it, which is the difference between a correction that
 * feels like an edit and one that feels like a rebuild.
 */
export async function readSpecLines(
  viewer: Viewer,
  onProgress?: (page: number, total: number) => void,
): Promise<SpecLine[]> {
  const lines: SpecLine[] = [];
  for (let page = 1; page <= viewer.numPages; page++) {
    onProgress?.(page, viewer.numPages);
    for (const line of await pageLines(viewer, page).catch(() => [])) {
      lines.push({ ...line, page });
    }
  }
  return lines;
}

/** Read a spec book out of the open document and parse it. */
export async function parseSpecs(
  viewer: Viewer,
  onProgress?: (page: number, total: number) => void,
  corrections?: readonly SpecCorrection[],
): Promise<SpecSection[]> {
  return parseSpecLines(await readSpecLines(viewer, onProgress), corrections);
}

/** A mention of a spec section found on a drawing sheet. */
export interface SpecReference {
  /** Normalised section number, matching a parsed `SpecSection.number`. */
  section: string;
  page: number;
  box: Box;
  /** The text as it appears on the sheet, e.g. `SEE SPEC 07 84 00`. */
  text: string;
}

/**
 * `07 84 00`, `07 8400`, `078400`.
 *
 * The word boundaries at both ends are load-bearing: without them this matches the first six
 * digits of any longer number, so a dimension string or a phone number in a title block would
 * read as a spec reference.
 */
const SECTION_MENTION = /\b(\d{2})[\s-]?(\d{2})[\s-]?(\d{2})\b/g;

/**
 * Find mentions of known spec sections in a page's words.
 *
 * Matched against the *parsed section list* rather than against the pattern alone: on a drawing,
 * six digits in a row is far more often a dimension, a door number or a date than a section
 * reference, and only cross-checking against sections that actually exist keeps the noise down.
 */
export function findSpecReferences(
  words: readonly Word[],
  sections: readonly SpecSection[],
  page: number,
): SpecReference[] {
  if (!words.length || !sections.length) return [];
  const known = new Set(sections.map((s) => s.number));

  // Join into a character stream with an owner map, so a section number split across words
  // ("07", "84", "00") is still found.
  let hay = "";
  const owner: number[] = [];
  words.forEach((w, i) => {
    if (hay) { hay += " "; owner.push(i); }
    for (let c = 0; c < w.str.length; c++) owner.push(i);
    hay += w.str;
  });

  const out: SpecReference[] = [];
  const seen = new Set<string>();
  SECTION_MENTION.lastIndex = 0;
  for (let m = SECTION_MENTION.exec(hay); m; m = SECTION_MENTION.exec(hay)) {
    const number = `${m[1]} ${m[2]} ${m[3]}`;
    if (!known.has(number)) continue;
    const key = `${number}@${m.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const first = owner[m.index] ?? 0;
    const last = owner[Math.min(m.index + m[0].length - 1, owner.length - 1)] ?? first;
    out.push({
      section: number,
      page,
      box: unionBox(words.slice(first, last + 1)),
      text: hay.slice(Math.max(0, m.index - 24), m.index + m[0].length + 12).trim(),
    });
  }
  return out;
}

/** Scan every page of the open document for mentions of the parsed sections. */
export async function scanSpecReferences(
  viewer: Viewer,
  sections: readonly SpecSection[],
): Promise<SpecReference[]> {
  const out: SpecReference[] = [];
  // Skip the pages the sections were parsed *from* — a spec book mentions its own number on every
  // page, and those are not drawing callouts.
  const specPages = new Set(sections.flatMap((s) => s.clauses.map((c) => c.page).concat(s.page)));
  for (let page = 1; page <= viewer.numPages; page++) {
    if (specPages.has(page)) continue;
    const words = splitWords(await viewer.pageText(page).catch(() => []));
    out.push(...findSpecReferences(words, sections, page));
  }
  return out;
}

/** Pull the actionable requirements out of parsed sections. */
export function extractRequirements(sections: readonly SpecSection[]): SpecRequirement[] {
  const out: SpecRequirement[] = [];
  for (const section of sections) {
    for (const clause of section.clauses) {
      // Headings aren't requirements; the text under them is.
      if (clause.depth < 2 || clause.text.length < 12) continue;
      const kind = REQUIREMENT_PATTERNS.find(([re]) => re.test(clause.text))?.[1];
      if (!kind) continue;
      out.push({ section: section.number, clause: clause.ref, kind, text: clause.text, page: clause.page });
    }
  }
  return out;
}

export function specsPlugin(options: SpecsOptions = {}) {
  return definePlugin({
    id: "specs",
    order: 45,
    setup(ctx) {
      let sections: SpecSection[] = [];
      let references: SpecReference[] = [];
      let parsed = false;
      let parsing = false;
      let corrections: SpecCorrection[] = [];
      /** The raw lines the parse came from, so a correction re-parses instead of re-reading. */
      let lines: SpecLine[] = [];

      const load = async (v: Viewer): Promise<SpecSection[]> => {
        if (parsed || parsing) return sections;
        parsing = true;
        try {
          corrections = options.corrections ? [...await options.corrections(v)] : corrections;
          if (options.sections) {
            // Host-supplied sections are the host's parse, not ours — correcting ours would be
            // correcting something nobody is looking at.
            sections = await options.sections(v);
          } else if (options.parse !== false && v.doc) {
            v.bus.emit("notice", { level: "info", message: "Reading specification sections…" });
            lines = await readSpecLines(v);
            sections = parseSpecLines(lines, corrections);
          }
          parsed = true;
          // Once sections are known, look for callouts naming them on the drawing sheets.
          references = sections.length && options.scanReferences !== false
            ? await scanSpecReferences(v, sections).catch(() => [])
            : [];
          v.bus.emit("notice", {
            level: sections.length ? "success" : "info",
            message: sections.length
              ? `Found ${sections.length} specification section${sections.length === 1 ? "" : "s"}`
                + (references.length ? `, referenced ${references.length} time${references.length === 1 ? "" : "s"} on the drawings.` : ".")
              : "No CSI specification sections found in this document.",
          });
        } catch (e) {
          v.bus.emit("notice", { level: "error", message: `Spec parse failed: ${(e as Error).message}` });
        } finally {
          parsing = false;
        }
        return sections;
      };

      /**
       * Re-parse from the cached lines after a correction.
       *
       * Deliberately does not re-scan the drawings for callouts. Rescuing a section heading changes
       * which sections are *known*, so a callout that was ignored as a stray six-digit number may
       * now be real — but re-scanning every sheet on each keystroke of a correction session would
       * make the panel unusable. References catch up on the next document load; the register, which
       * is what the correction was for, updates immediately.
       */
      const reparse = async (v: Viewer): Promise<void> => {
        if (options.sections) return;
        sections = parseSpecLines(lines, corrections);
        await options.onCorrect?.(corrections, v);
        v.redraw();
      };

      ctx.bus.on("doc:loaded", () => {
        sections = []; references = []; lines = []; corrections = []; parsed = false;
      });

      ctx.registerPanel({
        id: "specs", title: "Specifications", side: options.side ?? "left", order: 40,
        mount: (host, v) => mountSpecs(
          host, v, () => sections, () => references, () => load(v),
          options.promptText ?? ((title, initial) => Promise.resolve(window.prompt(title, initial ?? ""))),
        ),
      });

      /**
       * Cite the section a nearby drawing callout names. This is the pay-off for scanning
       * references: a markup dropped next to "SEE SPEC 07 84 00" can cite it without anyone typing
       * a section number.
       */
      ctx.registerAction({
        id: "specs.citeNearest", label: "Cite the spec called out here", icon: "🔗", group: "review",
        enabled: (v) => v.store.selectedIds().length > 0,
        async run(v) {
          await load(v);
          const selected = v.store.selected();
          let linked = 0;
          for (const a of selected) {
            const anchor = a.points[0];
            if (!anchor) continue;
            const onPage = references.filter((r) => r.page === a.page);
            if (!onPage.length) continue;
            // Nearest by centre-to-centre distance; a callout more than a third of the page away
            // is not what this markup is about.
            const info = v.doc?.pageInfoSync(a.page);
            const limit = info ? Math.max(info.width, info.height) / 3 : Infinity;
            let best: SpecReference | null = null;
            let bestD = limit;
            for (const r of onPage) {
              const d = Math.hypot(r.box.x + r.box.w / 2 - anchor.x, r.box.y + r.box.h / 2 - anchor.y);
              if (d < bestD) { bestD = d; best = r; }
            }
            if (!best) continue;
            v.store.update(a.id, { links: { ...a.links, spec: { section: best.section } } });
            linked++;
          }
          v.bus.emit("notice", {
            level: linked ? "success" : "warn",
            message: linked
              ? `Cited the nearest spec callout on ${linked} markup${linked === 1 ? "" : "s"}.`
              : "No spec callout found near the selection on this sheet.",
          });
        },
      });

      ctx.registerAction({
        id: "specs.parse", label: "Read specification sections", icon: "§", group: "view",
        run: (v) => load(v).then(() => v.redraw()),
      });

      ctx.viewer.specs = {
        sections: () => sections,
        references: () => references,
        load: () => load(ctx.viewer),
        requirements: () => extractRequirements(sections),
        lines: (page?: number) => (page === undefined ? lines : lines.filter((l) => l.page === page)),
        corrections: () => corrections,
        async correct(correction: SpecCorrection) {
          // Replace rather than append: one line has one classification, and a growing pile of
          // superseded entries is a persistence bug waiting to happen on the host's side.
          const key = correctionKey(correction.page, correction.text);
          corrections = corrections.filter((c) => correctionKey(c.page, c.text) !== key);
          corrections.push(correction);
          await reparse(ctx.viewer);
        },
        async uncorrect(page: number, text: string) {
          const key = correctionKey(page, text);
          const before = corrections.length;
          corrections = corrections.filter((c) => correctionKey(c.page, c.text) !== key);
          if (corrections.length === before) return false;
          await reparse(ctx.viewer);
          return true;
        },
        /** Cite a clause on a markup — the link that makes a spec reference navigable. */
        cite(annotId: string, section: string, clause?: string) {
          const a = ctx.store.get(annotId);
          if (!a) return false;
          ctx.store.update(annotId, {
            links: { ...a.links, spec: { section, ...(clause ? { clause } : {}) } },
          });
          return true;
        },
      };
    },
  });
}

function mountSpecs(
  host: HTMLElement,
  v: Viewer,
  get: () => SpecSection[],
  getRefs: () => SpecReference[],
  load: () => Promise<SpecSection[]>,
  ask: (title: string, initial?: string) => Promise<string | null>,
): () => void {
  const search = document.createElement("input");
  search.type = "search";
  search.className = "mpdf-input";
  search.placeholder = "Section number, title or keyword…";

  const tabs = document.createElement("div");
  tabs.className = "mpdf-chip-group";
  let mode: "sections" | "requirements" | "lines" = "sections";
  const tabBtns: Record<string, HTMLButtonElement> = {};
  for (const [key, label] of [
    ["sections", "Sections"], ["requirements", "Requirements"], ["lines", "Fix parsing"],
  ] as const) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mpdf-chip" + (key === mode ? " is-on" : "");
    b.textContent = label;
    b.onclick = () => {
      mode = key;
      for (const k in tabBtns) tabBtns[k]!.classList.toggle("is-on", k === mode);
      render();
    };
    tabBtns[key] = b;
    tabs.appendChild(b);
  }

  const body = document.createElement("div");
  body.setAttribute("aria-label", "Specification sections");
  body.className = "mpdf-list mpdf-spec-list";
  host.append(search, tabs, body);

  const empty = (msg: string, withButton = false) => {
    body.innerHTML = "";
    queueMicrotask(() => refreshRovingTabstops(body, '[role="button"]'));
    const p = document.createElement("p");
    p.className = "mpdf-empty";
    p.textContent = msg;
    body.appendChild(p);
    if (withButton) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mpdf-chest-tool";
      b.textContent = "Read specification sections";
      b.onclick = async () => { b.disabled = true; b.textContent = "Reading…"; await load(); render(); };
      body.appendChild(b);
    }
  };

  /** Identify a line by where it sits, which is exact — clause text is stripped of its ref. */
  const boxKey = (page: number, box: Box) => `${page}:${Math.round(box.x)}:${Math.round(box.y)}`;

  const DEPTHS: [string, string][] = [
    ["clause:0", "PART"], ["clause:1", "Article (1.1)"],
    ["clause:2", "Paragraph (A.)"], ["clause:3", "Subparagraph (1.)"],
  ];

  /**
   * What the parser saw on this page, and a control to overrule it.
   *
   * Scoped to one page because that is where the person already is when they notice the parse is
   * wrong, and because a spec book is tens of thousands of lines — a flat list of all of them is
   * not something anyone can find a heading in.
   */
  const renderLines = () => {
    body.innerHTML = "";
    const api = v.specs;
    const all = api?.lines() ?? [];
    if (!all.length) {
      empty("Nothing read yet. Read the sections first, then come back to fix whatever the parser got wrong.", true);
      return;
    }

    const page = v.page;
    const onPage = all.filter((l) => l.page === page);

    const head = document.createElement("p");
    head.className = "mpdf-empty";
    head.textContent = onPage.length
      ? `Page ${page}: ${onPage.length} line${onPage.length === 1 ? "" : "s"}. Changing one updates the register immediately.`
      : `No text read on page ${page}. Turn to a page of the specification.`;
    body.appendChild(head);
    if (!onPage.length) return;

    // What the current parse made of each line, matched by position: a clause's `text` has its ref
    // stripped, so it cannot be compared against the raw line.
    const decided = new Map<string, string>();
    for (const s of get()) {
      if (s.box && s.page === page) decided.set(boxKey(s.page, s.box), `§ ${s.number}`);
      for (const c of s.clauses) if (c.page === page) decided.set(boxKey(c.page, c.box), c.ref);
    }
    const corrected = new Map(api!.corrections().map((c) => [correctionKey(c.page, c.text), c]));

    for (const line of onPage) {
      const row = document.createElement("div");
      row.className = "mpdf-spec-line";

      const badge = document.createElement("span");
      badge.className = "mpdf-spec-ref";
      badge.textContent = decided.get(boxKey(line.page, line.box)) ?? "—";

      const txt = document.createElement("span");
      txt.className = "mpdf-spec-line-text";
      txt.textContent = line.text;

      const override = corrected.get(correctionKey(line.page, line.text));
      const current = !override ? ""
        : override.as === "clause" ? `clause:${override.depth ?? 1}`
          : override.as;

      const select = document.createElement("select");
      select.className = "mpdf-input mpdf-spec-line-as";
      // A plain tab stop rather than a roving one: roving works by taking children out of the tab
      // order and moving between them with arrows, and arrows inside a `<select>` already mean
      // "change the value". This is a form, and forms are tabbed through.
      select.setAttribute("aria-label", `What is this line: ${line.text}`);
      for (const [value, label] of [["", "Auto"], ["section", "Section heading"], ...DEPTHS, ["none", "Not a heading"]] as [string, string][]) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        if (value === current) opt.selected = true;
        select.appendChild(opt);
      }
      if (override) row.dataset.corrected = "true";

      select.onchange = () => { void applyChoice(line, select.value, current); };
      row.append(badge, txt, select);
      body.appendChild(row);
    }
  };

  /** Turn a choice from the dropdown into a correction, then re-render so the badges catch up. */
  const applyChoice = async (line: SpecLine, choice: string, previous: string): Promise<void> => {
    const api = v.specs;
    if (!api) return;
    const at = { page: line.page, text: line.text };
    if (!choice) {
      await api.uncorrect(line.page, line.text);
    } else if (choice === "none") {
      await api.correct({ ...at, as: "none" });
    } else if (choice === "section") {
      let number = looseSectionNumber(line.text);
      if (!number) {
        // The line carries no readable number, so there is nothing to address the section by and
        // guessing would put an entry in the register that no drawing can cite.
        const typed = await ask("CSI section number for this line (e.g. 07 84 00)", "");
        number = typed ? looseSectionNumber(typed) : undefined;
        if (!number) {
          v.bus.emit("notice", { level: "warn", message: "A section needs a CSI number like 07 84 00." });
          renderLines();
          return;
        }
      }
      await api.correct({ ...at, as: "section", number });
    } else {
      await api.correct({ ...at, as: "clause", depth: Number(choice.split(":")[1]) });
    }
    if (choice !== previous) {
      v.bus.emit("notice", { level: "success", message: `Re-read page ${line.page}; ${get().length} section${get().length === 1 ? "" : "s"} now.` });
    }
    renderLines();
  };

  const render = () => {
    if (mode === "lines") { renderLines(); return; }
    const sections = get();
    if (!sections.length) {
      empty("No sections read yet. Specs are parsed on demand — a 900-page book is not something to index before anyone asks.", true);
      return;
    }
    const q = search.value.trim().toLowerCase();
    body.innerHTML = "";
    queueMicrotask(() => refreshRovingTabstops(body, '[role="button"]'));

    if (mode === "requirements") {
      const reqs = extractRequirements(sections)
        .filter((r) => !q || `${r.section} ${r.clause} ${r.text}`.toLowerCase().includes(q));
      if (!reqs.length) { empty(q ? "No matching requirements." : "No requirements extracted."); return; }
      for (const r of reqs.slice(0, 400)) {
        const row = document.createElement("article");
        row.className = "mpdf-row";
        const badge = document.createElement("span");
        badge.className = "mpdf-hit-source";
        badge.dataset.source = r.kind;
        badge.textContent = r.kind;
        const main = document.createElement("div");
        main.className = "mpdf-row-main";
        const title = document.createElement("div");
        title.className = "mpdf-row-title";
        title.textContent = r.text;
        const meta = document.createElement("div");
        meta.className = "mpdf-row-meta";
        meta.textContent = `${r.section} §${r.clause} · p.${r.page}`;
        main.append(title, meta);
        row.append(badge, main);
        activate(row, () => void v.goToPage(r.page), {
          // Includes the row's own text: `aria-label` overrides content rather than adding to it,
          // so a bare "Go to page 12" would suppress the reference and read identically for every
          // row on that page.
          label: `${r.text} — ${r.section} clause ${r.clause}, page ${r.page}`,
          roving: true,
        });
        body.appendChild(row);
      }
      return;
    }

    const matching = sections.filter((s) =>
      !q || `${s.number} ${s.title}`.toLowerCase().includes(q)
      || s.clauses.some((c) => c.text.toLowerCase().includes(q)));
    if (!matching.length) { empty("No matching sections."); return; }

    for (const section of matching) {
      const details = document.createElement("details");
      details.className = "mpdf-spec-section";
      // Auto-open when the search matched inside the section rather than in its heading.
      if (q && !`${section.number} ${section.title}`.toLowerCase().includes(q)) details.open = true;

      const summary = document.createElement("summary");
      summary.className = "mpdf-spec-heading";
      const num = document.createElement("strong");
      num.textContent = section.number;
      const ttl = document.createElement("span");
      ttl.textContent = section.title;
      summary.append(num, ttl);
      // Where this section is called out on the drawings — the cross-link the spec asks for.
      const refs = getRefs().filter((r) => r.section === section.number);
      if (refs.length) {
        const where = document.createElement("em");
        where.className = "mpdf-spec-refs";
        const sheets = [...new Set(refs.map((r) => v.store.sheet(r.page)?.number ?? `p.${r.page}`))];
        where.textContent = `on ${sheets.slice(0, 3).join(", ")}${sheets.length > 3 ? "…" : ""}`;
        where.title = "Referenced on these sheets — click to jump";
        where.onclick = (e) => { e.stopPropagation(); void v.goToPage(refs[0]!.page); };
        summary.appendChild(where);
      }
      summary.onclick = (e) => {
        // Let the disclosure toggle, but also navigate to the section.
        if ((e.target as HTMLElement).tagName !== "SUMMARY") return;
        void v.goToPage(section.page);
      };
      details.appendChild(summary);

      for (const clause of section.clauses) {
        if (q && !clause.text.toLowerCase().includes(q) && !`${section.number} ${section.title}`.toLowerCase().includes(q)) continue;
        const row = document.createElement("div");
        row.className = "mpdf-spec-clause";
        row.dataset.depth = String(clause.depth);
        const ref = document.createElement("span");
        ref.className = "mpdf-spec-ref";
        ref.textContent = clause.ref;
        const txt = document.createElement("span");
        txt.textContent = clause.text;
        row.append(ref, txt);
        activate(row, () => void v.goToPage(clause.page), {
          // The clause text is the whole point of this panel; labelling the row "Go to page 12"
          // would hide it from exactly the people who cannot read it off the screen.
          label: `${clause.ref} ${clause.text}, page ${clause.page}`,
          roving: true,
        });

        // Cite: attach this clause to whatever markup is selected.
        const cite = document.createElement("button");
        cite.type = "button";
        cite.className = "mpdf-icon-btn";
        cite.textContent = "🔗";
        cite.title = "Cite this clause on the selected markup";
        cite.onclick = (e) => {
          e.stopPropagation();
          const selected = v.store.selectedIds();
          if (!selected.length) {
            v.bus.emit("notice", { level: "warn", message: "Select a markup first, then cite a clause." });
            return;
          }
          for (const id of selected) v.specs?.cite(id, section.number, clause.ref);
          v.bus.emit("notice", {
            level: "success",
            message: `Cited ${section.number} §${clause.ref} on ${selected.length} markup${selected.length === 1 ? "" : "s"}.`,
          });
        };
        row.appendChild(cite);
        details.appendChild(row);
      }
      body.appendChild(details);
    }
  };

  search.oninput = render;
  const offs = [
    v.on("doc:loaded", render),
    v.on("annot:selected", () => { /* cite button state is read live */ }),
    // The line inspector shows one page, so turning the page has to redraw it.
    v.on("page:changed", () => { if (mode === "lines") renderLines(); }),
  ];
  render();
  const stopRoving = rovingFocus(body, '[role="button"]');
  return () => { offs.forEach((off) => off()); stopRoving(); };
}

declare module "../core/viewer" {
  interface Viewer {
    /** Present once the specs plugin is installed. */
    specs?: {
      sections(): SpecSection[];
      references(): SpecReference[];
      load(): Promise<SpecSection[]>;
      requirements(): SpecRequirement[];
      cite(annotId: string, section: string, clause?: string): boolean;
      /** Every line the parser read, or just one page's — what a correction points at. */
      lines(page?: number): SpecLine[];
      /** Corrections currently in force. */
      corrections(): SpecCorrection[];
      /** Classify one line, replacing any previous correction on it, and re-parse. */
      correct(correction: SpecCorrection): Promise<void>;
      /** Drop the correction on a line, returning `false` if there was none. Re-parses. */
      uncorrect(page: number, text: string): Promise<boolean>;
    };
  }
}
