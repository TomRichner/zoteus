import { z } from 'zod';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { okLibraryContent, optionalLibrary } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { provenance } from './common-output.js';
import { localAttachmentPath } from '../features/attachments/local-path.js';

/**
 * Citation keys, in both directions, for a manuscript that cites with `[@key]`.
 *
 * Better BibTeX writes the keys it generates into Zotero's own `citationKey` field
 * (Zotero 7 and later have one), and Zotero's quick search matches that field, so a
 * citekey resolves to its item over the ordinary library read route with no call to the
 * plugin: the desktop app answers key-free, and the Web API answers for a synced library
 * when the app is closed. `zotero_export format:"better-biblatex"` stays the way to get
 * BBT's formatted entries; this tool answers the question that comes before it, "is this
 * key in the library, and which item is it".
 *
 * A quick-search hit is not enough on its own: `q` also matches titles and creators, so a
 * key like `smith2020` would match anything by Smith. Only an item whose `citationKey` is
 * exactly the key asked for counts, with the `Citation Key:` line BBT used to write into
 * `extra` accepted for libraries that predate the field.
 */

const MAX_KEYS = 50;

function extraCitekey(extra: unknown): string | undefined {
  if (typeof extra !== 'string') return undefined;
  const m = /^\s*Citation Key:\s*(\S+)\s*$/im.exec(extra);
  return m?.[1];
}

/** The item's BBT citation key: the native field first, the legacy `extra` line second. */
export function itemCitekey(item: any): string | undefined {
  const d = item?.data ?? item ?? {};
  const native = d.citationKey;
  if (typeof native === 'string' && native.trim()) return native.trim();
  return extraCitekey(d.extra);
}

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const attachmentOut = z
  .object({
    key: z.string().describe('Attachment item key.'),
    filename: z.string().optional().describe('File name as Zotero recorded it.'),
    contentType: z.string().optional().describe('MIME type as Zotero recorded it.'),
    linkMode: z.string().optional().describe('imported_file, imported_url, linked_file or linked_url.'),
    localPath: z.string().optional().describe('Absolute path of the file on the machine running Zoteus; absent on a remote deployment.'),
    localPathExists: z.boolean().optional().describe('Whether that file is on disk right now.'),
    localPathNote: z.string().optional().describe('Why no usable local path could be given.'),
  })
  .passthrough();

const citekeys: ToolDefinition = {
  name: 'zotero_citekeys',
  title: 'Resolve Better BibTeX citation keys',
  description:
    'Look up Better BibTeX citation keys in both directions, for a manuscript that cites with `[@key]`. Give `citekeys` to check which keys exist in the library and which item each one is (key, title, item type), with that item\'s attachments and their local file paths (`include_attachments`, default true) so a PDF can be handed to another program by citekey; a key that is absent is reported with `found: false` rather than guessed. Give `item_keys` to get the citation key of each item, for adding a citation to the manuscript. Keys are matched exactly and case-sensitively against the item\'s `citationKey` field, which the Better BibTeX plugin fills in; without that plugin every key reports as absent. Reads follow the ordinary library route (desktop app key-free, Web API otherwise). For BBT\'s formatted BibLaTeX entries use `zotero_export format:"better-biblatex"`; to find an item by author or title use `zotero_search_items`.',
  inputSchema: {
    citekeys: z
      .array(z.string().min(1))
      .max(MAX_KEYS)
      .optional()
      .describe(`Citation keys to resolve to items, e.g. ["abbottSynapticDepressionCortical1997"]. At most ${MAX_KEYS} per call.`),
    item_keys: z
      .array(z.string().min(1))
      .max(MAX_KEYS)
      .optional()
      .describe(`8-character item keys whose citation keys you want. At most ${MAX_KEYS} per call.`),
    include_attachments: z
      .boolean()
      .optional()
      .describe('For `citekeys`: also list each found item\'s attachments with their local file paths (default true).'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      keys: z
        .array(
          z
            .object({
              citekey: z.string().describe('The key as asked for.'),
              found: z.boolean().describe('Whether an item carries exactly this citation key.'),
              itemKey: z.string().optional().describe('The item that carries it.'),
              itemType: z.string().optional().describe('Zotero item type of that item.'),
              title: z.string().optional().describe('Title of that item.'),
              attachments: z.array(attachmentOut).optional().describe('Child attachments of that item, with local paths where known.'),
            })
            .passthrough(),
        )
        .optional()
        .describe('One entry per requested citekey, in request order.'),
      items: z
        .array(
          z
            .object({
              itemKey: z.string().describe('The item key as asked for.'),
              found: z.boolean().describe('Whether the library has this item.'),
              citekey: z.string().nullable().optional().describe('Its citation key, or null when the item has none.'),
              title: z.string().optional().describe('Title of the item.'),
            })
            .passthrough(),
        )
        .optional()
        .describe('One entry per requested item key, in request order.'),
      missing: z.array(z.string()).optional().describe('The citekeys that no item carries.'),
      provenance,
    })
    .passthrough(),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const wantKeys: string[] = args.citekeys ?? [];
    const wantItems: string[] = args.item_keys ?? [];
    if (!wantKeys.length && !wantItems.length) return err('Give `citekeys` and/or `item_keys`.');
    const library = optionalLibrary(args);
    const structured: Record<string, unknown> = {};
    const summary: string[] = [];

    if (wantKeys.length) {
      const includeAtt = args.include_attachments !== false;
      const out: any[] = [];
      const missing: string[] = [];
      for (const citekey of wantKeys) {
        // Quick search reaches the citationKey field, but reaches titles and creators too,
        // so the hits are filtered down to the exact key; a few extra rows cover the case
        // where a title happens to contain the key's words.
        const hits = await ctx.router.searchItems({ q: citekey, qmode: 'titleCreatorYear', limit: 10, library });
        const item = (hits.data ?? []).find((it: any) => itemCitekey(it) === citekey);
        if (!item) {
          out.push({ citekey, found: false });
          missing.push(citekey);
          continue;
        }
        const d = item.data ?? item;
        const entry: any = { citekey, found: true, itemKey: item.key ?? d.key, itemType: d.itemType, title: d.title };
        if (includeAtt) {
          const children = await ctx.router.getItemChildren(entry.itemKey, { library });
          entry.attachments = (children.data ?? [])
            .filter((c: any) => (c.data?.itemType ?? c.itemType) === 'attachment')
            .map((c: any) => {
              const cd = c.data ?? c;
              return {
                key: c.key ?? cd.key,
                filename: cd.filename,
                contentType: cd.contentType,
                linkMode: cd.linkMode,
                ...localAttachmentPath(ctx, c),
              };
            });
        }
        out.push(entry);
      }
      structured.keys = out;
      structured.missing = missing;
      summary.push(
        `${wantKeys.length - missing.length} of ${wantKeys.length} citekey(s) found` +
          (missing.length ? `; missing: ${missing.join(', ')}` : ''),
      );
    }

    if (wantItems.length) {
      // Both APIs take up to 50 keys in one itemKey filter, which is also this tool's cap.
      const res = await ctx.router.searchItems({ itemKey: wantItems.join(','), limit: MAX_KEYS, library });
      const byKey = new Map<string, any>((res.data ?? []).map((it: any) => [it.key ?? it.data?.key, it]));
      const out = wantItems.map((itemKey) => {
        const item = byKey.get(itemKey);
        if (!item) return { itemKey, found: false, citekey: null };
        const d = item.data ?? item;
        return { itemKey, found: true, citekey: itemCitekey(item) ?? null, title: d.title };
      });
      structured.items = out;
      const withKey = out.filter((o) => o.citekey).length;
      summary.push(`${withKey} of ${wantItems.length} item(s) have a citation key`);
    }

    return okLibraryContent(structured, summary.join('. ') + '.');
  },
};

export default citekeys;
