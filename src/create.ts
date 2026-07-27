/**
 * The batteries-included entry point.
 *
 * `new Viewer({...})` plus the standard plugin set, in the order they expect. Hosts that want a
 * different UI or a subset construct the `Viewer` themselves — this is a convenience, not a
 * requirement, and nothing in the kernel depends on it.
 */
import { Viewer, type ViewerOptions } from "./core/viewer";
import { configureWorker, workerConfigured } from "./core/document";
import { markupPlugin, type MarkupOptions } from "./plugins/markup";
import { measurePlugin, type MeasureOptions } from "./plugins/measure";
import { stampsPlugin, type StampOptions } from "./plugins/stamps";
import { pinsPlugin, type PinOptions } from "./plugins/pins";
import { markupListPlugin, type MarkupListOptions } from "./plugins/markupList";
import { comparePlugin, type CompareOptions } from "./plugins/compare";
import { sheetsPlugin, type SheetsOptions } from "./plugins/sheets";
import { toolbarPlugin, type ToolbarOptions } from "./plugins/toolbar";
import { exportersPlugin, type ExportOptions } from "./plugins/exporters";
import { persistencePlugin, type PersistenceOptions } from "./plugins/persistence";
import type { ViewerPlugin } from "./core/plugin";

export interface CreateViewerOptions extends Omit<ViewerOptions, "plugins"> {
  /** URL of the bundled pdf.js worker. Required unless `configureWorker` was already called. */
  workerUrl?: string;
  /** Per-plugin options; `false` disables a plugin entirely. */
  markup?: MarkupOptions | false;
  measure?: MeasureOptions | false;
  stamps?: StampOptions | false;
  pins?: PinOptions | false;
  list?: MarkupListOptions | false;
  compare?: CompareOptions | false;
  sheets?: SheetsOptions | false;
  toolbar?: ToolbarOptions | false;
  exporters?: ExportOptions | false;
  /** Persistence is opt-in — omit it and markups live only in memory. */
  persistence?: PersistenceOptions;
  /** Extra plugins, installed after the standard set. */
  plugins?: ViewerPlugin[];
}

/** Build a viewer with the standard plugin set. */
export async function createViewer(options: CreateViewerOptions): Promise<Viewer> {
  const {
    workerUrl, markup, measure, stamps, pins, list, compare, sheets, toolbar, exporters,
    persistence, plugins = [], ...viewerOptions
  } = options;

  if (workerUrl) configureWorker(workerUrl);
  if (!workerConfigured()) {
    throw new Error(
      "No pdf.js worker configured. Pass `workerUrl` (bundle it — do not load it from a CDN, the viewer must work offline) " +
      "or call configureWorker() yourself before creating a viewer.",
    );
  }

  const viewer = new Viewer(viewerOptions);
  const standard: (ViewerPlugin | null)[] = [
    sheets === false ? null : sheetsPlugin(sheets ?? {}),
    markup === false ? null : markupPlugin(markup ?? {}),
    measure === false ? null : measurePlugin(measure ?? {}),
    stamps === false ? null : stampsPlugin(stamps ?? {}),
    pins === false ? null : pinsPlugin(pins ?? {}),
    list === false ? null : markupListPlugin(list ?? {}),
    compare === false ? null : comparePlugin(compare ?? {}),
    exporters === false ? null : exportersPlugin(exporters ?? {}),
    persistence ? persistencePlugin(persistence) : null,
    ...plugins,
    // The toolbar last, so it sees every registered tool and action.
    toolbar === false ? null : toolbarPlugin(toolbar ?? {}),
  ];

  for (const plugin of standard) {
    if (plugin) await viewer.use(plugin);
  }
  return viewer;
}
