import { describe, expect, it } from "vitest";
import { zip } from "../src/io/zip";
import { toBcfTopic, toBcfZip, topicMarkupXml } from "../src/io/bcf";
import { findSpecReferences, parseSpecLines, type SpecLine } from "../src/plugins/specs";
import { splitWords } from "../src/core/textLayer";
import type { Annotation } from "../src/core/types";
import type { TextItem } from "../src/core/document";

// ---- ZIP -------------------------------------------------------------------

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

/**
 * Minimal ZIP reader, used only by these tests. Reading the central directory back is the only
 * honest way to check the writer produced a real archive rather than plausible-looking bytes.
 */
function readZip(bytes: Uint8Array): { name: string; data: string; crcOk: boolean }[] {
  // Locate the end-of-central-directory record by scanning back for its signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");

  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);
  const out: { name: string; data: string; crcOk: boolean }[] = [];
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i++) {
    if (u32(bytes, at) !== 0x02014b50) throw new Error(`bad central header at entry ${i}`);
    const crc = u32(bytes, at + 16);
    const size = u32(bytes, at + 24);
    const nameLen = u16(bytes, at + 28);
    const extraLen = u16(bytes, at + 30);
    const commentLen = u16(bytes, at + 32);
    const localAt = u32(bytes, at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));

    if (u32(bytes, localAt) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const lNameLen = u16(bytes, localAt + 26);
    const lExtraLen = u16(bytes, localAt + 28);
    const dataAt = localAt + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(dataAt, dataAt + size);

    out.push({ name, data: decoder.decode(data), crcOk: crc32(data) === crc });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]!;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe("zip writer", () => {
  it("round-trips entries through a real central-directory read", () => {
    const archive = zip([
      { name: "a.txt", data: "hello" },
      { name: "nested/b.xml", data: "<x/>" },
    ]);
    const back = readZip(archive);
    expect(back.map((e) => e.name)).toEqual(["a.txt", "nested/b.xml"]);
    expect(back[0]!.data).toBe("hello");
    expect(back[1]!.data).toBe("<x/>");
  });

  it("writes a correct CRC for every entry", () => {
    const back = readZip(zip([
      { name: "one", data: "the quick brown fox" },
      { name: "two", data: "" },
    ]));
    expect(back.every((e) => e.crcOk)).toBe(true);
  });

  it("starts with the local file header signature", () => {
    const archive = zip([{ name: "x", data: "y" }]);
    expect(u32(archive, 0)).toBe(0x04034b50);
  });

  it("handles an empty archive", () => {
    expect(readZip(zip([]))).toEqual([]);
  });

  it("preserves UTF-8 in names and content", () => {
    const back = readZip(zip([{ name: "sección/año.txt", data: "façade — 12'-6\"" }]));
    expect(back[0]!.name).toBe("sección/año.txt");
    expect(back[0]!.data).toBe("façade — 12'-6\"");
  });

  it("is byte-reproducible for the same input", () => {
    const a = zip([{ name: "a", data: "x" }]);
    const b = zip([{ name: "a", data: "x" }]);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

// ---- BCF archive -----------------------------------------------------------

const pin = (over: Partial<Annotation> = {}): Annotation => ({
  id: "an_1", kind: "pin", sheetId: "A-201", page: 1,
  points: [{ x: 306, y: 396 }], nx: 0.5, ny: 0.5,
  author: "A. Reviewer", createdAt: "2026-07-20T09:30:00.000Z", version: 1,
  status: "open", subject: "Verify slab depression",
  ext: { issueType: "RFI" }, ...over,
});

describe("bcfzip", () => {
  it("writes bcf.version and one markup.bcf per topic", () => {
    const topics = [toBcfTopic(pin()), toBcfTopic(pin({ id: "an_2", subject: "Second" }))];
    const back = readZip(toBcfZip(topics));
    expect(back.some((e) => e.name === "bcf.version")).toBe(true);
    const markups = back.filter((e) => e.name.endsWith("/markup.bcf"));
    expect(markups).toHaveLength(2);
    // Each topic gets its own GUID-named folder, as BCF 2.1 requires.
    expect(markups[0]!.name).toBe(`${topics[0]!.topic.guid}/markup.bcf`);
  });

  it("produces well-formed markup XML carrying the topic fields", () => {
    const xml = topicMarkupXml(toBcfTopic(pin({ priority: "high" })));
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(xml).toContain("<Title>Verify slab depression</Title>");
    expect(xml).toContain("<CreationAuthor>A. Reviewer</CreationAuthor>");
    expect(xml).toContain('TopicType="RFI"');
    expect(xml).toContain('TopicStatus="Open"');
    expect(xml).toContain("<Priority>High</Priority>");
  });

  it("keeps the sheet anchor as a reference link so it round-trips", () => {
    const xml = topicMarkupXml(toBcfTopic(pin(), { documentName: "A-201.pdf" }));
    expect(xml).toContain("massing:sheet-anchor:");
    expect(xml).toContain("A-201.pdf");
  });

  it("writes replies as Comment elements bound to the topic", () => {
    const withReply = pin({
      replies: [{ id: "rep_1", author: "B. Engineer", body: "Confirmed", createdAt: "2026-07-21T08:00:00.000Z" }],
    });
    const entry = toBcfTopic(withReply);
    const xml = topicMarkupXml(entry);
    expect(xml).toContain("<Comment Guid=");
    expect(xml).toContain("<Comment>Confirmed</Comment>");
    expect(xml).toContain(`<TopicGuid>${entry.topic.guid}</TopicGuid>`);
  });

  it("escapes XML metacharacters in user text", () => {
    const xml = topicMarkupXml(toBcfTopic(pin({ subject: `A & B <tag> "quoted"` })));
    expect(xml).not.toContain("<tag>");
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    expect(doc.querySelector("parsererror")).toBeNull();
  });

  it("includes project.bcfp only when a project is named", () => {
    const topics = [toBcfTopic(pin())];
    expect(readZip(toBcfZip(topics)).some((e) => e.name === "project.bcfp")).toBe(false);
    expect(readZip(toBcfZip(topics, { projectName: "Sample" })).some((e) => e.name === "project.bcfp")).toBe(true);
  });
});

// ---- spec references -------------------------------------------------------

const item = (str: string, x: number, y: number, w: number, h = 10): TextItem => ({ str, x, y, w, h });

const SECTIONS = parseSpecLines(([
  { text: "SECTION 07 84 00 - FIRESTOPPING", page: 9 },
  { text: "SECTION 09 91 23 - INTERIOR PAINTING", page: 20 },
] as { text: string; page: number }[]).map((l) => ({ ...l, box: { x: 0, y: 0, w: 100, h: 10 } })) as SpecLine[]);

describe("findSpecReferences", () => {
  it("finds a callout naming a known section", () => {
    const words = splitWords([item("FIRESTOP PER SPEC 07 84 00", 100, 200, 260)]);
    const refs = findSpecReferences(words, SECTIONS, 3);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.section).toBe("07 84 00");
    expect(refs[0]!.page).toBe(3);
    expect(refs[0]!.box.w).toBeGreaterThan(0);
  });

  it("matches a number split across separate text runs", () => {
    const words = splitWords([item("SEE", 0, 0, 30), item("07", 40, 0, 20), item("84", 65, 0, 20), item("00", 90, 0, 20)]);
    expect(findSpecReferences(words, SECTIONS, 1)).toHaveLength(1);
  });

  it("ignores six-digit runs that are not a known section", () => {
    // A door number, a date, a dimension — all six digits, none of them a spec reference.
    const words = splitWords([item("DOOR 10 20 30 AND 99 99 99", 0, 0, 260)]);
    expect(findSpecReferences(words, SECTIONS, 1)).toHaveLength(0);
  });

  it("does not match inside a longer number", () => {
    // Without word boundaries this would read the first six digits of a phone number as 07 84 00.
    const words = splitWords([item("CALL 0784001234", 0, 0, 150)]);
    expect(findSpecReferences(words, SECTIONS, 1)).toHaveLength(0);
  });

  it("finds several distinct sections on one sheet", () => {
    const words = splitWords([item("SEE 07 84 00 AND ALSO 09 91 23", 0, 0, 300)]);
    const refs = findSpecReferences(words, SECTIONS, 4);
    expect(refs.map((r) => r.section).sort()).toEqual(["07 84 00", "09 91 23"]);
  });

  it("returns nothing without words or without sections", () => {
    expect(findSpecReferences([], SECTIONS, 1)).toHaveLength(0);
    expect(findSpecReferences(splitWords([item("07 84 00", 0, 0, 80)]), [], 1)).toHaveLength(0);
  });

  it("carries surrounding text so the callout is recognisable", () => {
    const words = splitWords([item("FIRESTOP PER SPEC 07 84 00", 0, 0, 260)]);
    expect(findSpecReferences(words, SECTIONS, 1)[0]!.text).toMatch(/FIRESTOP/);
  });
});
