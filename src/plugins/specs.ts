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
import { splitWords, unionBox } from "../core/textLayer";
import type { Box } from "../core/types";
import type { PdfDocument } from "../core/document";
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
  side?: "left" | "right";
  /** Skip parsing entirely (this document is a drawing set, not a spec book). */
  parse?: boolean;
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
async function pageLines(doc: PdfDocument, page: number): Promise<{ text: string; box: Box }[]> {
  const words = splitWords(await doc.textItems(page));
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
 * Parse spec lines into sections and clauses.
 *
 * Deliberately heuristic and forgiving: spec formatting varies enough between offices that anything
 * stricter would fail on half of real projects. A section with no recognisable clauses is still
 * returned — being able to jump to `07 84 00` is most of the value even without clause anchors.
 *
 * Kept free of pdf.js so the heuristics can be exercised directly against sample text.
 */
export function parseSpecLines(lines: readonly SpecLine[]): SpecSection[] {
  const sections: SpecSection[] = [];
  let current: SpecSection | null = null;
  let part = "1";
  let article = "";

  for (const line of lines) {
    const { text, page } = line;
    if (!text || text.length > 220) continue;

    const sec = SECTION_HEADING.exec(text);
    // Guard against matching a stray dimension string: a real section heading has a title.
    if (sec && sec[4] && /[A-Za-z]{3}/.test(sec[4])) {
      const number = `${sec[1]} ${sec[2]} ${sec[3]}`;
      current = {
        number,
        title: sec[4].trim().replace(/\.+$/, ""),
        page,
        division: sec[1]!,
        clauses: [],
      };
      sections.push(current);
      part = "1";
      article = "";
      continue;
    }
    if (!current) continue;

    const partM = PART_HEADING.exec(text);
    if (partM) {
      part = partM[1]!;
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

/** Read a spec book out of a PDF and parse it. */
export async function parseSpecs(
  doc: PdfDocument,
  onProgress?: (page: number, total: number) => void,
): Promise<SpecSection[]> {
  const lines: SpecLine[] = [];
  for (let page = 1; page <= doc.numPages; page++) {
    onProgress?.(page, doc.numPages);
    for (const line of await pageLines(doc, page).catch(() => [])) {
      lines.push({ ...line, page });
    }
  }
  return parseSpecLines(lines);
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
      let parsed = false;
      let parsing = false;

      const load = async (v: Viewer): Promise<SpecSection[]> => {
        if (parsed || parsing) return sections;
        parsing = true;
        try {
          if (options.sections) {
            sections = await options.sections(v);
          } else if (options.parse !== false && v.doc) {
            v.bus.emit("notice", { level: "info", message: "Reading specification sections…" });
            sections = await parseSpecs(v.doc);
          }
          parsed = true;
          v.bus.emit("notice", {
            level: sections.length ? "success" : "info",
            message: sections.length
              ? `Found ${sections.length} specification section${sections.length === 1 ? "" : "s"}.`
              : "No CSI specification sections found in this document.",
          });
        } catch (e) {
          v.bus.emit("notice", { level: "error", message: `Spec parse failed: ${(e as Error).message}` });
        } finally {
          parsing = false;
        }
        return sections;
      };

      ctx.bus.on("doc:loaded", () => { sections = []; parsed = false; });

      ctx.registerPanel({
        id: "specs", title: "Specifications", side: options.side ?? "left", order: 40,
        mount: (host, v) => mountSpecs(host, v, () => sections, () => load(v)),
      });

      ctx.registerAction({
        id: "specs.parse", label: "Read specification sections", icon: "§", group: "view",
        run: (v) => load(v).then(() => v.redraw()),
      });

      ctx.viewer.specs = {
        sections: () => sections,
        load: () => load(ctx.viewer),
        requirements: () => extractRequirements(sections),
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
  load: () => Promise<SpecSection[]>,
): () => void {
  const search = document.createElement("input");
  search.type = "search";
  search.className = "mpdf-input";
  search.placeholder = "Section number, title or keyword…";

  const tabs = document.createElement("div");
  tabs.className = "mpdf-chip-group";
  let mode: "sections" | "requirements" = "sections";
  const tabBtns: Record<string, HTMLButtonElement> = {};
  for (const [key, label] of [["sections", "Sections"], ["requirements", "Requirements"]] as const) {
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
  body.className = "mpdf-list mpdf-spec-list";
  host.append(search, tabs, body);

  const empty = (msg: string, withButton = false) => {
    body.innerHTML = "";
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

  const render = () => {
    const sections = get();
    if (!sections.length) {
      empty("No sections read yet. Specs are parsed on demand — a 900-page book is not something to index before anyone asks.", true);
      return;
    }
    const q = search.value.trim().toLowerCase();
    body.innerHTML = "";

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
        row.onclick = () => void v.goToPage(r.page);
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
        row.onclick = () => void v.goToPage(clause.page);

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
  const offs = [v.on("doc:loaded", render), v.on("annot:selected", () => { /* cite button state is read live */ })];
  render();
  return () => offs.forEach((off) => off());
}

declare module "../core/viewer" {
  interface Viewer {
    /** Present once the specs plugin is installed. */
    specs?: {
      sections(): SpecSection[];
      load(): Promise<SpecSection[]>;
      requirements(): SpecRequirement[];
      cite(annotId: string, section: string, clause?: string): boolean;
    };
  }
}
