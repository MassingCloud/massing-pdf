/**
 * The standalone demo app.
 *
 * Deliberately server-free: it wires the viewer to the IndexedDB adapter, so markups persist across
 * reloads with no backend at all. That is both a genuinely useful field mode and the honest way to
 * demonstrate the adapter contract — swapping `IndexedDbAdapter` for `RestAdapter` (or wrapping
 * both in `OfflineAdapter`) is the only change needed to point it at a real server.
 */
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  IndexedDbAdapter, createViewer, indexedDbAvailable, type StorageAdapter, MemoryAdapter,
} from "../src/index";
import { makeSampleSheet } from "./sample";

const host = document.getElementById("viewer")!;
const drop = document.getElementById("drop")!;
const errBox = document.getElementById("err")!;
const fileInput = document.getElementById("file") as HTMLInputElement;
const sampleBtn = document.getElementById("sample") as HTMLButtonElement;

host.style.cssText = "position:absolute;inset:0";

const fail = (e: unknown) => {
  errBox.textContent = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error(e);
};

// IndexedDB is unavailable in some private-browsing modes; degrade to in-memory rather than refusing
// to open the document at all.
const adapter: StorageAdapter = indexedDbAvailable() ? new IndexedDbAdapter() : new MemoryAdapter();

const viewer = await createViewer({
  container: host,
  workerUrl,
  author: localStorage.getItem("mpdf.author") || "Demo reviewer",
  org: "Massing",
  initialZoom: "fit-width",
  feetInches: true,
  persistence: {
    adapter,
    // Key on the PDF's own fingerprint: reopening the same drawing brings its markups back even if
    // the file was renamed or came from a different folder.
    key: (v) => ({ documentId: v.doc?.fingerprint ?? "unknown" }),
  },
}).catch((e) => { fail(e); throw e; });

// Surface viewer notices as a transient banner; the toolbar's status bar already shows them, this
// just makes errors during load visible before the shell is on screen.
viewer.on("notice", ({ level, message }) => {
  if (level === "error") errBox.textContent = message;
});

async function open(source: File | { url: string; name: string }): Promise<void> {
  errBox.textContent = "";
  try {
    await viewer.load(source);
    drop.classList.add("is-hidden");
  } catch (e) {
    drop.classList.remove("is-hidden");
    fail(e);
  }
}

fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) void open(f);
});

sampleBtn.addEventListener("click", async () => {
  sampleBtn.disabled = true;
  sampleBtn.textContent = "Generating…";
  try {
    const bytes = await makeSampleSheet();
    const file = new File([bytes as BlobPart], "A-201-SECOND-FLOOR-PLAN.pdf", { type: "application/pdf" });
    await open(file);
  } catch (e) {
    fail(e);
  } finally {
    sampleBtn.disabled = false;
    sampleBtn.textContent = "Load a sample sheet";
  }
});

// Drag-and-drop anywhere in the window, which is how people actually open a drawing.
for (const type of ["dragenter", "dragover"]) {
  window.addEventListener(type, (e) => {
    e.preventDefault();
    if (drop.classList.contains("is-hidden")) return;
    drop.classList.add("is-over");
  });
}
window.addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null) drop.classList.remove("is-over");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("is-over");
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f?.type === "application/pdf" || f?.name.toLowerCase().endsWith(".pdf")) void open(f);
});

// Expose the viewer for console poking and for the smoke test.
Object.assign(window, { viewer });
