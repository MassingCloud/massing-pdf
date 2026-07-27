import { describe, expect, it } from "vitest";
import { fromXfdf, toXfdf } from "../src/io/xfdf";
import { decodeAnchor, fromBcfTopic, normaliseGuid, toBcfTopic } from "../src/io/bcf";
import { toCsv, toTakeoffCsv } from "../src/io/csv";
import { facets, isEmptyFilter, matchesFilter } from "../src/core/filter";
import type { Annotation } from "../src/core/types";

const PAGES = new Map([[1, { width: 612, height: 792 }]]);

/** A minimal RFC 4180 reader, so the CSV tests verify what a spreadsheet would actually see. */
function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cell); cell = ""; }
    else cell += ch;
  }
  out.push(cell);
  return out;
}

const annot = (over: Partial<Annotation> = {}): Annotation => ({
  id: "an_1",
  kind: "rect",
  sheetId: "A-201",
  page: 1,
  points: [{ x: 100, y: 200 }, { x: 300, y: 400 }],
  author: "A. Reviewer",
  org: "Massing",
  createdAt: "2026-07-20T09:30:00.000Z",
  version: 1,
  status: "open",
  subject: "Check header size",
  note: "Confirm the lintel schedule",
  discipline: "structural",
  style: { color: "#2f6fd0", width: 2 },
  ...over,
});

describe("XFDF", () => {
  it("produces a well-formed document", () => {
    const xml = toXfdf([annot()], { pages: PAGES, href: "A-201.pdf" });
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(xml).toContain('xmlns="http://ns.adobe.com/xfdf/"');
    expect(xml).toContain('href="A-201.pdf"');
  });

  it("uses 0-based pages and bottom-left origin coordinates", () => {
    const xml = toXfdf([annot()], { pages: PAGES });
    expect(xml).toContain('page="0"');
    // y=200 (top-left) on a 792pt page is y=592 bottom-left; y=400 → 392.
    expect(xml).toContain('rect="100,392,300,592"');
  });

  it("round-trips geometry back to top-left origin", () => {
    const xml = toXfdf([annot()], { pages: PAGES });
    const [back] = fromXfdf(xml, { pages: PAGES });
    expect(back!.points[0]).toEqual({ x: 100, y: 200 });
    expect(back!.points[1]).toEqual({ x: 300, y: 400 });
  });

  it("round-trips the structured fields XFDF has no vocabulary for", () => {
    const source = annot({
      status: "in_review",
      priority: "high",
      trade: "05 Metals",
      labels: ["coordination"],
      quantity: { value: 12.5, unit: "m", raw: 250 },
      links: { issueId: "RFI-014", ifcGuids: ["3Dx7Ka$"] },
      revision: { rev: "C", migration: "shifted" },
      provenance: { archive: "Soane", confidence: "uncertain" },
    });
    const [back] = fromXfdf(toXfdf([source], { pages: PAGES }), { pages: PAGES });
    expect(back!.status).toBe("in_review");
    expect(back!.priority).toBe("high");
    expect(back!.trade).toBe("05 Metals");
    expect(back!.labels).toEqual(["coordination"]);
    expect(back!.quantity).toEqual({ value: 12.5, unit: "m", raw: 250 });
    expect(back!.links?.issueId).toBe("RFI-014");
    expect(back!.revision?.rev).toBe("C");
    expect(back!.provenance?.confidence).toBe("uncertain");
    expect(back!.discipline).toBe("structural");
  });

  it("preserves identity and authorship across a round trip", () => {
    const [back] = fromXfdf(toXfdf([annot()], { pages: PAGES }), { pages: PAGES });
    expect(back!.id).toBe("an_1");
    expect(back!.author).toBe("A. Reviewer");
    expect(back!.createdAt).toBe("2026-07-20T09:30:00.000Z");
  });

  it("maps a revision cloud to a polygon with the cloud intent", () => {
    const cloud = annot({ kind: "cloud", points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }] });
    const xml = toXfdf([cloud], { pages: PAGES });
    expect(xml).toContain("<polygon");
    expect(xml).toContain('intent="PolygonCloud"');
    const [back] = fromXfdf(xml, { pages: PAGES });
    expect(back!.kind).toBe("cloud");
  });

  it("recovers the cloud kind from the intent alone when the payload is stripped", () => {
    const cloud = annot({ kind: "cloud", points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }] });
    const xml = toXfdf([cloud], { pages: PAGES, includeExtensions: false });
    expect(xml).not.toContain("massing:record");
    const [back] = fromXfdf(xml, { pages: PAGES });
    expect(back!.kind).toBe("cloud");
    expect(back!.points).toHaveLength(3);
  });

  it("carries replies as in-reply-to annotations", () => {
    const withReply = annot({
      replies: [{ id: "rep_1", author: "B. Engineer", body: "Agreed", createdAt: "2026-07-21T10:00:00.000Z" }],
    });
    const xml = toXfdf([withReply], { pages: PAGES });
    expect(xml).toContain('inreplyto="an_1"');
    const [back] = fromXfdf(xml, { pages: PAGES });
    expect(back!.replies).toHaveLength(1);
    expect(back!.replies![0]!.author).toBe("B. Engineer");
  });

  it("does not import replies as top-level markups", () => {
    const withReply = annot({
      replies: [{ id: "rep_1", author: "B", body: "x", createdAt: "2026-07-21T10:00:00.000Z" }],
    });
    const back = fromXfdf(toXfdf([withReply], { pages: PAGES }), { pages: PAGES });
    expect(back).toHaveLength(1);
  });

  it("escapes markup in user text", () => {
    const xml = toXfdf([annot({ note: `<script>alert("x")</script> & more` })], { pages: PAGES });
    expect(xml).not.toContain("<script>");
    const [back] = fromXfdf(xml, { pages: PAGES });
    expect(back!.note).toBe(`<script>alert("x")</script> & more`);
  });

  it("rejects a document that is not XFDF", () => {
    expect(() => fromXfdf("<html><body>not a markup file</body></html>", { pages: PAGES }))
      .toThrow(/no <xfdf> element/i);
  });

  it("skips markups on pages the caller did not supply", () => {
    const offPage = annot({ page: 9 });
    const xml = toXfdf([offPage], { pages: PAGES });
    expect(xml).not.toContain("<square");
  });
});

describe("BCF", () => {
  it("maps a pin to a topic with a decodable sheet anchor", () => {
    const pin = annot({
      kind: "pin", points: [{ x: 306, y: 396 }], nx: 0.5, ny: 0.5,
      ext: { issueType: "Punch item", assignee: "C. Super", dueDate: "2026-08-01" },
    });
    const { topic } = toBcfTopic(pin, { documentName: "A-201.pdf" });
    expect(topic.topic_type).toBe("Punch item");
    expect(topic.assigned_to).toBe("C. Super");
    expect(topic.due_date).toBe("2026-08-01");
    const anchor = decodeAnchor(topic.reference_links![0]!)!;
    expect(anchor).toMatchObject({ sheetId: "A-201", page: 1, nx: 0.5, ny: 0.5, document: "A-201.pdf" });
  });

  it("maps status both ways", () => {
    const { topic } = toBcfTopic(annot({ kind: "pin", status: "resolved", nx: 0.1, ny: 0.2 }));
    expect(topic.topic_status).toBe("Resolved");
    const back = fromBcfTopic(topic)!;
    expect(back.status).toBe("resolved");
  });

  it("re-places a topic using the page box", () => {
    const pin = annot({ kind: "pin", points: [{ x: 306, y: 396 }], nx: 0.5, ny: 0.5 });
    const { topic } = toBcfTopic(pin);
    const back = fromBcfTopic(topic, [], () => ({ width: 1224, height: 1584 }))!;
    // Same relative position on a sheet plotted at double size.
    expect(back.points[0]).toEqual({ x: 612, y: 792 });
  });

  it("folds the measurement and IFC links into the description", () => {
    const pin = annot({
      kind: "pin", nx: 0, ny: 0,
      quantity: { value: 4.25, unit: "m" },
      links: { ifcGuids: ["1abc", "2def"] },
    });
    const { topic } = toBcfTopic(pin);
    expect(topic.description).toContain("4.250 m");
    expect(topic.description).toContain("1abc, 2def");
  });

  it("carries replies as comments bound to the topic", () => {
    const pin = annot({
      kind: "pin", nx: 0, ny: 0,
      replies: [{ id: "rep_1", author: "B", body: "Fixed", createdAt: "2026-07-22T08:00:00.000Z" }],
    });
    const { topic, comments } = toBcfTopic(pin);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.topic_guid).toBe(topic.guid);
    const back = fromBcfTopic(topic, comments)!;
    expect(back.replies![0]!.body).toBe("Fixed");
  });

  it("returns null for a topic that carries no sheet anchor", () => {
    expect(fromBcfTopic({
      guid: "x", topic_type: "Issue", topic_status: "Open",
      title: "t", creation_date: "2026-01-01T00:00:00Z", creation_author: "a",
    })).toBeNull();
  });

  describe("normaliseGuid", () => {
    it("passes a real UUID through, lower-cased", () => {
      const uuid = "3F2504E0-4F89-41D3-9A0C-0305E82C3301";
      expect(normaliseGuid(uuid)).toBe(uuid.toLowerCase());
    });

    it("strips the id prefix before checking for a UUID", () => {
      expect(normaliseGuid("an_3f2504e0-4f89-41d3-9a0c-0305e82c3301"))
        .toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    });

    it("derives a stable, valid-shaped GUID from a non-UUID id", () => {
      const g = normaliseGuid("an_abc123");
      expect(g).toBe(normaliseGuid("an_abc123"));
      expect(g).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("derives different GUIDs for different ids", () => {
      expect(normaliseGuid("an_one")).not.toBe(normaliseGuid("an_two"));
    });
  });
});

describe("CSV", () => {
  it("writes a header and one row per markup", () => {
    const csv = toCsv([annot()]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toContain("Subject");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Check header size");
  });

  it("prefers the sheet number over the raw page", () => {
    const csv = toCsv([annot()], { sheetNumber: () => "A-201" });
    expect(csv.split("\r\n")[1]).toContain("A-201");
  });

  it("quotes cells containing the delimiter, quotes or newlines", () => {
    const csv = toCsv([annot({ note: 'Says "no", then yes' })]);
    expect(csv).toContain('"Says ""no"", then yes"');
  });

  it("defuses spreadsheet formula injection", () => {
    const csv = toCsv([annot({ subject: "=cmd|'/c calc'!A1" })]);
    expect(csv).toContain("'=cmd");
  });

  it("splits a value into formatted, numeric and unit columns", () => {
    const csv = toCsv([annot({ quantity: { value: 12.5, unit: "ft" } })]);
    const [header, row] = csv.split("\r\n").map(parseCsvRow) as [string[], string[]];
    expect(row[header.indexOf("Value")]).toBe("12.5");
    expect(row[header.indexOf("Unit")]).toBe("ft");
    // The formatted cell contains a double quote, so the file must escape it — and a conforming
    // reader must get the original string back.
    expect(csv).toContain(`"12'-6"""`);
    expect(row[header.indexOf("Quantity")]).toBe(`12'-6"`);
  });

  it("rolls up a takeoff by item and unit", () => {
    const csv = toTakeoffCsv([
      annot({ id: "1", subject: "Wall", quantity: { value: 10, unit: "m" } }),
      annot({ id: "2", subject: "Wall", quantity: { value: 5, unit: "m" } }),
      annot({ id: "3", subject: "Slab", quantity: { value: 20, unit: "m²" } }),
    ]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.startsWith("Wall"))).toContain("15");
  });

  it("keeps mixed units in the same bucket as separate rows", () => {
    const csv = toTakeoffCsv([
      annot({ id: "1", subject: "Wall", quantity: { value: 10, unit: "m" } }),
      annot({ id: "2", subject: "Wall", quantity: { value: 4, unit: "m²" } }),
    ]);
    expect(csv.split("\r\n")).toHaveLength(3);
  });
});

describe("filter", () => {
  const set = [
    annot({ id: "1", status: "open", discipline: "structural", author: "Ann", kind: "cloud" }),
    annot({ id: "2", status: "resolved", discipline: "mechanical", author: "Ben", kind: "rect" }),
    annot({ id: "3", status: "open", discipline: "mechanical", author: "Ann", kind: "rect", links: { issueId: "RFI-1" } }),
  ];

  it("treats an empty filter as matching everything", () => {
    expect(isEmptyFilter({})).toBe(true);
    expect(set.every((a) => matchesFilter(a, {}))).toBe(true);
  });

  it("filters by status, discipline, author and kind", () => {
    expect(set.filter((a) => matchesFilter(a, { status: ["open"] })).map((a) => a.id)).toEqual(["1", "3"]);
    expect(set.filter((a) => matchesFilter(a, { discipline: ["mechanical"] })).map((a) => a.id)).toEqual(["2", "3"]);
    expect(set.filter((a) => matchesFilter(a, { authors: ["Ann"] })).map((a) => a.id)).toEqual(["1", "3"]);
    expect(set.filter((a) => matchesFilter(a, { kinds: ["cloud"] })).map((a) => a.id)).toEqual(["1"]);
  });

  it("ANDs multiple facets together", () => {
    const hits = set.filter((a) => matchesFilter(a, { status: ["open"], discipline: ["mechanical"] }));
    expect(hits.map((a) => a.id)).toEqual(["3"]);
  });

  it("filters on whether a markup is linked to an issue", () => {
    expect(set.filter((a) => matchesFilter(a, { hasIssue: true })).map((a) => a.id)).toEqual(["3"]);
    expect(set.filter((a) => matchesFilter(a, { hasIssue: false })).map((a) => a.id)).toEqual(["1", "2"]);
  });

  it("searches subject, note, author and labels case-insensitively", () => {
    expect(matchesFilter(annot({ subject: "Firestopping missing" }), { query: "firestop" })).toBe(true);
    expect(matchesFilter(annot({ labels: ["clash"] }), { query: "clash" })).toBe(true);
    expect(matchesFilter(annot(), { query: "nothing here" })).toBe(false);
  });

  it("counts facets in descending order of frequency", () => {
    const f = facets(set);
    expect(f.status[0]).toEqual(["open", 2]);
    expect(f.authors[0]).toEqual(["Ann", 2]);
  });
});
