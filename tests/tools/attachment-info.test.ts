import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import attachment from '../../src/tools/attachment.js';

/**
 * `zotero_attachment action:"info"` reports where the file is on this machine.
 *
 * The path was always computable (bytes.ts reads it), but never returned, so a pipeline
 * that hands the PDF to another program had to rebuild `<dataDir>/storage/<key>/<name>`
 * itself from two fields of the record.
 */

let dataDir: string;
const PDF = { key: 'ATTPDF01', data: { itemType: 'attachment', linkMode: 'imported_url', filename: 'paper.pdf', contentType: 'application/pdf', parentItem: 'PARENT01' } };
const MD = { key: 'ATTMD001', data: { itemType: 'attachment', linkMode: 'imported_file', filename: 'paper_ocr.md', contentType: 'text/markdown', parentItem: 'PARENT01' } };
const PARENT = { key: 'PARENT01', data: { itemType: 'journalArticle', title: 'A paper' } };

function ctx(over: Record<string, unknown> = {}) {
  const items: Record<string, any> = { ATTPDF01: PDF, ATTMD001: MD, PARENT01: PARENT };
  return {
    config: { dataDir: join(dataDir, 'zoteus'), zoteroDataDir: dataDir },
    remoteCaller: false,
    router: {
      defaultLibrary: () => ({ type: 'user', id: 1 }),
      getItem: vi.fn(async (key: string) => items[key]),
      getItemChildren: vi.fn(async () => ({ data: [MD, PDF], totalResults: 2, lastModifiedVersion: 1 })),
    },
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    ...over,
  } as never;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'zoteus-zotero-'));
  await mkdir(join(dataDir, 'storage', 'ATTPDF01'), { recursive: true });
  await writeFile(join(dataDir, 'storage', 'ATTPDF01', 'paper.pdf'), '%PDF-1.4');
});
afterAll(() => rm(dataDir, { recursive: true, force: true }));

describe('zotero_attachment info: local path', () => {
  it('returns the storage path of a stored attachment and whether it exists', async () => {
    const res = await attachment.handler({ action: 'info', item_key: 'ATTPDF01' }, ctx());
    const s = res.structuredContent as any;
    expect(s.localPath).toBe(join(dataDir, 'storage', 'ATTPDF01', 'paper.pdf'));
    expect(s.localPathExists).toBe(true);
    expect((res.content?.[0] as any).text).toContain(s.localPath);
  });

  it('flags a stored attachment whose file is not on disk', async () => {
    const res = await attachment.handler({ action: 'info', item_key: 'ATTMD001' }, ctx());
    const s = res.structuredContent as any;
    expect(s.localPath).toBe(join(dataDir, 'storage', 'ATTMD001', 'paper_ocr.md'));
    expect(s.localPathExists).toBe(false);
    expect((res.content?.[0] as any).text).toContain('missing on disk');
  });

  it('accepts a parent item key and describes its best readable attachment (the PDF)', async () => {
    const res = await attachment.handler({ action: 'info', item_key: 'PARENT01' }, ctx());
    const s = res.structuredContent as any;
    expect(s.attachment.key).toBe('ATTPDF01');
    expect(s.localPath).toBe(join(dataDir, 'storage', 'ATTPDF01', 'paper.pdf'));
    expect((res.content?.[0] as any).text).toContain('best readable attachment of item PARENT01');
  });

  it('errors for a parent with no attachment', async () => {
    const c = ctx({
      router: {
        defaultLibrary: () => ({ type: 'user', id: 1 }),
        getItem: vi.fn(async () => PARENT),
        getItemChildren: vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 1 })),
      },
    });
    const res = await attachment.handler({ action: 'info', item_key: 'PARENT01' }, c);
    expect(res.isError).toBe(true);
  });

  it('never discloses a path to a remote caller', async () => {
    const res = await attachment.handler({ action: 'info', item_key: 'ATTPDF01' }, ctx({ remoteCaller: true }));
    const s = res.structuredContent as any;
    expect(s.localPath).toBeUndefined();
    expect(s.localPathExists).toBeUndefined();
    expect(s.attachment.key).toBe('ATTPDF01');
  });

  it('returns a linked file’s own absolute path, and explains a base-directory-relative one', async () => {
    const abs = join(dataDir, 'storage', 'ATTPDF01', 'paper.pdf');
    const linked = { key: 'LINKED01', data: { itemType: 'attachment', linkMode: 'linked_file', path: abs, title: 'Linked' } };
    const rel = { key: 'LINKED02', data: { itemType: 'attachment', linkMode: 'linked_file', path: 'attachments:sub/paper.pdf', title: 'Rel' } };
    const c = ctx({
      router: {
        defaultLibrary: () => ({ type: 'user', id: 1 }),
        getItem: vi.fn(async (k: string) => (k === 'LINKED01' ? linked : rel)),
        getItemChildren: vi.fn(),
      },
    });
    const a = (await attachment.handler({ action: 'info', item_key: 'LINKED01' }, c)).structuredContent as any;
    expect(a.localPath).toBe(abs);
    expect(a.localPathExists).toBe(true);
    const b = (await attachment.handler({ action: 'info', item_key: 'LINKED02' }, c)).structuredContent as any;
    expect(b.localPath).toBeUndefined();
    expect(b.localPathNote).toMatch(/base directory/);
  });
});
