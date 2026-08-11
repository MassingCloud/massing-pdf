/**
 * A conflict-resolution dialog.
 *
 * The client already detects a 409, carries both sides of every conflicted markup, and can resolve
 * by policy. What it could not do is ask a human — `persistencePlugin`'s `onConflict` hook took a
 * callback and nothing implemented it, so "keep theirs" was the only realistic answer and a
 * reviewer's edit was discarded without them seeing what it lost to.
 *
 * This is a *reference*, not the only way. Two products consume this library and both needed the
 * same panel; one implementation they can replace beats two that drift. Replacing it is a matter of
 * supplying your own `onConflict` and not installing this plugin.
 *
 * ```ts
 * const conflicts = conflictsPlugin();
 *
 * const viewer = await createViewer({
 *   container, workerUrl,
 *   plugins: [conflicts],
 *   persistence: {
 *     adapter, key,
 *     onConflictResolve: "ask",
 *     onConflict: (c) => conflicts.ask(c),
 *   },
 * });
 * ```
 *
 * `ask` hangs off the plugin rather than only off the viewer for a dull but load-bearing reason:
 * `onConflict: (c) => viewer.conflicts!.ask(c)` inside the `createViewer` call refers to the
 * variable being declared, and TypeScript answers `TS7022: 'viewer' implicitly has type 'any'
 * because it is referenced directly or indirectly in its own initializer` — then infers `any`
 * through the rest of the demo. It runs correctly and typechecks as garbage. Handing back the
 * handle avoids the self-reference entirely. `viewer.conflicts` is still there for host code and
 * the console.
 */
import { definePlugin, type ViewerPlugin } from "../core/plugin";
import { activate, trapFocus } from "../core/a11y";
import type { Annotation } from "../core/types";
import type { Conflict } from "./persistence";

export interface ConflictsOptions {
  /**
   * How to describe an author. Defaults to the name on the record.
   *
   * A host that knows its directory can turn `b.engineer@…` into a person, which matters here more
   * than elsewhere: the question being asked is literally "yours or theirs", and "theirs" is much
   * easier to answer about a name than an address.
   */
  describeAuthor?: (annot: Annotation) => string;
  /**
   * Seconds to wait before answering for the user. Unset means wait indefinitely.
   *
   * A dialog nobody is present to answer stalls the whole save queue behind it, because resolution
   * runs inline. On a site tablet left on a bench that is the normal case, not the exception.
   */
  timeoutSeconds?: number;
}

/** The fields worth showing. Geometry is summarised rather than dumped as coordinates. */
const COMPARED: { key: keyof Annotation; label: string }[] = [
  { key: "subject", label: "Subject" },
  { key: "note", label: "Comment" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "assignee", label: "Assigned to" },
  { key: "dueDate", label: "Due" },
  { key: "discipline", label: "Discipline" },
];

/** Render a value as the short string a reviewer can compare at a glance. */
function show(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  return String(value);
}

/**
 * Which fields actually differ, so the dialog shows the decision rather than the whole record.
 *
 * Both sides are required. Diffing against a missing record renders every populated field of the
 * one you have against an em dash, which reads as "their version has no subject and no status" —
 * a claim about the other side that a bodyless 409 never made.
 */
function differences(mine: Annotation, theirs: Annotation): { label: string; mine: string; theirs: string }[] {
  const rows: { label: string; mine: string; theirs: string }[] = [];
  for (const { key, label } of COMPARED) {
    const a = show(mine[key]);
    const b = show(theirs[key]);
    if (a !== b) rows.push({ label, mine: a, theirs: b });
  }
  // Geometry compared by shape, not by value: two arrays of points are never usefully diffed in a
  // dialog, but "one of you moved it" is exactly what the reviewer needs to know.
  if (JSON.stringify(mine.points) !== JSON.stringify(theirs.points)) {
    rows.push({ label: "Position", mine: "moved", theirs: "moved differently" });
  }
  return rows;
}

/** The plugin, with the resolver hanging off it so it can be wired without a self-reference. */
export interface ConflictsPlugin extends ViewerPlugin {
  /** Present one conflict and resolve with the version to keep, or `null` for the server's. */
  ask(conflict: Conflict): Promise<Annotation | null>;
}

export function conflictsPlugin(options: ConflictsOptions = {}): ConflictsPlugin {
  let installed: ((conflict: Conflict) => Promise<Annotation | null>) | null = null;

  const plugin = definePlugin({
    id: "conflicts",
    order: 90,
    setup(ctx) {
      const { viewer } = ctx;
      const author = options.describeAuthor ?? ((a: Annotation) => a.author);

      /**
       * Present one conflict and wait for an answer.
       *
       * Resolves with the annotation to keep, or `null` to accept the server's copy — the shape
       * `persistencePlugin`'s `onConflict` expects.
       */
      const ask = (conflict: Conflict): Promise<Annotation | null> => new Promise((resolve) => {
        const { mine, theirs } = conflict;

        const backdrop = document.createElement("div");
        backdrop.className = "mpdf-conflict-backdrop";
        const box = document.createElement("div");
        box.className = "mpdf-conflict";
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-modal", "true");
        box.setAttribute("aria-labelledby", "mpdf-conflict-title");

        const title = document.createElement("h2");
        title.id = "mpdf-conflict-title";
        title.className = "mpdf-conflict-title";
        title.textContent = "This markup changed while you were editing it";

        const blurb = document.createElement("p");
        blurb.className = "mpdf-conflict-blurb";
        blurb.textContent = !mine
          ? "Someone else saved a different version of a markup you no longer have a change for. "
            + "Their version will be kept."
          : theirs
            ? `${author(theirs)} saved a different version. Choose which to keep.`
            : "Someone else saved a different version, and the server did not say what it holds. "
              + "Keeping yours will overwrite theirs.";

        box.append(title, blurb);

        // A side-by-side table needs two sides. With only one, the honest presentation is the
        // sentence above and nothing else — a column of em dashes states what the other version
        // holds, which is the one thing a bodyless rejection does not tell us. Not even an empty
        // table, which a screen reader announces as "table, zero rows".
        if (mine && theirs) {
          const rows = differences(mine, theirs);
          const table = document.createElement("table");
          table.className = "mpdf-conflict-table";
          const head = document.createElement("tr");
          for (const h of ["", "Yours", `${author(theirs)}'s`]) {
            const th = document.createElement("th");
            th.textContent = h;
            head.appendChild(th);
          }
          table.appendChild(head);
          for (const row of rows) {
            const tr = document.createElement("tr");
            for (const cell of [row.label, row.mine, row.theirs]) {
              const td = document.createElement("td");
              td.textContent = cell;
              tr.appendChild(td);
            }
            table.appendChild(tr);
          }
          if (!rows.length) {
            // Both sides changed, but not in any field shown here — style, replies, extensions.
            // Saying so beats an empty table that reads as "nothing is different, why am I being
            // asked" and gets dismissed without being read.
            const tr = document.createElement("tr");
            const td = document.createElement("td");
            td.colSpan = 3;
            td.textContent = "The visible fields match; the difference is in data not shown here.";
            tr.appendChild(td);
            table.appendChild(tr);
          }
          box.appendChild(table);
        }

        const actions = document.createElement("div");
        actions.className = "mpdf-conflict-actions";

        let release: (() => void) | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const close = (kept: Annotation | null) => {
          clearTimeout(timer);
          release?.();
          backdrop.remove();
          resolve(kept);
        };

        const keepTheirs = document.createElement("button");
        keepTheirs.type = "button";
        keepTheirs.className = "mpdf-conflict-btn";
        keepTheirs.textContent = mine ? "Keep theirs" : "OK";
        activate(keepTheirs, () => close(null), {
          label: mine ? "Discard my change and keep their version" : "Dismiss",
        });
        actions.appendChild(keepTheirs);

        // With no local version there is nothing to keep, and a "Keep mine" that resolves null
        // would be a button that reports doing the opposite of what it says.
        if (mine) {
          const keepMine = document.createElement("button");
          keepMine.type = "button";
          keepMine.className = "mpdf-conflict-btn is-primary";
          keepMine.textContent = "Keep mine";
          activate(keepMine, () => close(mine), {
            label: "Keep my change and overwrite their version",
          });
          // Theirs first, and it is the default: overwriting someone else's work should be the
          // deliberate choice rather than the one that happens by leaning on the keyboard.
          actions.appendChild(keepMine);
        }
        box.appendChild(actions);
        backdrop.appendChild(box);
        viewer.el.root.appendChild(backdrop);

        // Escape means "do not overwrite anyone", which is the same as keeping theirs.
        box.addEventListener("keydown", (e) => {
          if (e.key === "Escape") { e.preventDefault(); close(null); }
        });

        release = trapFocus(box);
        keepTheirs.focus();
        viewer.announce("A markup changed while you were editing it. Choose which version to keep.", "assertive");

        if (options.timeoutSeconds && options.timeoutSeconds > 0) {
          timer = setTimeout(() => {
            // Answering for them keeps the save queue moving, and keeping theirs is the answer that
            // destroys nothing — their edit is still in the store to re-apply.
            viewer.announce("No answer given, so their version was kept.", "polite");
            close(null);
          }, options.timeoutSeconds * 1000);
        }
      });

      installed = ask;
      viewer.conflicts = { ask };
      ctx.onCleanup(() => { installed = null; delete viewer.conflicts; });
    },
  });

  return Object.assign(plugin, {
    ask: (conflict: Conflict): Promise<Annotation | null> => {
      if (installed) return installed(conflict);
      // Wired to a viewer it was never installed on. Resolving `null` keeps the server's copy,
      // which is the same answer every other ambiguous path here gives — throwing would escape
      // into the save queue's conflict handler, which does not expect one.
      console.warn("[massing-pdf] conflictsPlugin.ask called before the plugin was installed; keeping the server's version.");
      return Promise.resolve(null);
    },
  });
}

declare module "../core/viewer" {
  interface Viewer {
    /** Present once the conflicts plugin is installed. */
    conflicts?: {
      /** Present one conflict and resolve with the version to keep, or `null` for the server's. */
      ask(conflict: Conflict): Promise<Annotation | null>;
    };
  }
}
