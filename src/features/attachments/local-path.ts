import { existsSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { ToolContext } from '../../registry/registry.js';

/**
 * Where an attachment's file lives on THIS machine, for a caller that wants to hand the
 * file to another program rather than read it through Zoteus.
 *
 * `bytes.ts` already knows the answer — it reads `<dataDir>/storage/<key>/<filename>`
 * when the desktop app is not running — but it consumes the path internally and only
 * reports a `fileSource` label. An OCR pipeline, or anything else that takes a file
 * path, had to rebuild the path from the attachment key and filename by hand. This
 * module is that computation, made explicit, so a tool can return it.
 *
 * Returns nothing for a remote caller: on a shared deployment the path names the
 * operator's disk, which the caller cannot reach and should not learn about. The same
 * rule `caller-path.ts` applies to paths coming IN is applied to paths going OUT.
 */

export interface LocalAttachmentPath {
  /** Absolute path of the attachment's file on the machine running Zoteus. */
  localPath?: string;
  /** Whether that file is present on disk right now. */
  localPathExists?: boolean;
  /** Why there is no usable path, when there is not. */
  localPathNote?: string;
}

/** Zotero's linked-file paths may be relative to a user-configured base directory. */
const BASE_DIR_PREFIX = 'attachments:';

export function localAttachmentPath(ctx: ToolContext, item: any): LocalAttachmentPath {
  if (ctx.remoteCaller) return {};
  const d = item?.data ?? item ?? {};
  const key: string | undefined = item?.key ?? d.key;
  const linkMode: string = d.linkMode ?? '';

  if (linkMode === 'linked_url') {
    return { localPathNote: 'A linked URL attachment has no file.' };
  }
  if (linkMode === 'linked_file') {
    const p: string = d.path ?? '';
    if (!p) return { localPathNote: 'A linked file attachment with no path recorded.' };
    if (p.startsWith(BASE_DIR_PREFIX)) {
      return {
        localPathNote:
          `Linked file stored relative to Zotero's linked attachment base directory: \`${p}\`. ` +
          'Resolve it against the base directory set in Zotero > Settings > Advanced > Files and Folders.',
      };
    }
    return isAbsolute(p)
      ? { localPath: p, localPathExists: existsSync(p) }
      : { localPathNote: `Linked file path is not absolute: \`${p}\`.` };
  }

  // imported_file / imported_url: the file sits in the storage folder under its key.
  const dataDir = ctx.config?.zoteroDataDir;
  if (!dataDir) return { localPathNote: 'ZOTERO_DATA_DIR is not set, so the storage folder is unknown.' };
  if (!key) return { localPathNote: 'The attachment has no key.' };
  const name = d.filename ? basename(String(d.filename)) : undefined;
  if (!name) return { localPathNote: 'The attachment has no filename recorded.' };
  const localPath = join(dataDir, 'storage', basename(String(key)), name);
  return { localPath, localPathExists: existsSync(localPath) };
}
