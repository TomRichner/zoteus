import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import citekeys, { itemCitekey } from '../../src/tools/citekeys.js';

/**
 * A manuscript cites with `[@abbottSynapticDepressionCortical1997]`; the question before
 * exporting anything is whether that key is in the library and which item it is. Better
 * BibTeX fills Zotero's `citationKey` field, and quick search reaches it, so the tool
 * resolves keys over the ordinary read route with no call to the plugin.
 */

let dataDir: string;

const ABBOTT = {
  key: 'ABBOTT01',
  data: { key: 'ABBOTT01', itemType: 'journalArticle', title: 'Synaptic depression and cortical gain control', citationKey: 'abbottSynapticDepressionCortical1997' },
};
// A quick search for "smith2020" also matches every Smith: the key must match exactly.
const SMITH_OTHER = { key: 'SMITH002', data: { itemType: 'journalArticle', title: 'Something by Smith', citationKey: 'smithSomething2020' } };
const SMITH = { key: 'SMITH001', data: { itemType: 'book', title: 'Smith 2020', citationKey: 'smith2020' } };
// Legacy: the key BBT used to pin in `extra` before Zotero had a field for it.
const LEGACY = { key: 'LEGACY01', data: { itemType: 'report', title: 'Old report', extra: 'PMID: 1\nCitation Key: oldReport1999\n' } };
const PDF = { key: 'ATTPDF01', data: { itemType: 'attachment', linkMode: 'imported_url', filename: 'abbott.pdf', contentType: 'application/pdf', parentItem: 'ABBOTT01' } };
const NOTE = { key: 'NOTE0001', data: { itemType: 'note', parentItem: 'ABBOTT01' } };

function ctx(over: Record<string, unknown> = {}) {
  const all = [ABBOTT, SMITH_OTHER, SMITH, LEGACY];
  return {
    config: { dataDir: join(dataDir, 'zoteus'), zoteroDataDir: dataDir },
    remoteCaller: false,
    router: {
      defaultLibrary: () => ({ type: 'user', id: 1 }),
      searchItems: vi.fn(async (q: any) => {
        if (q.itemKey) {
          const keys = String(q.itemKey).split(',');
          return { data: all.filter((it) => keys.includes(it.key)), totalResults: 0, lastModifiedVersion: 1 };
        }
        const needle = String(q.q).toLowerCase();
        const data = all.filter(
          (it) =>
            it.data.title.toLowerCase().includes(needle.replace(/\d+$/, '').toLowerCase()) ||
            (itemCitekey(it) ?? '').toLowerCase().includes(needle),
        );
        return { data, totalResults: data.length, lastModifiedVersion: 1 };
      }),
      getItemChildren: vi.fn(async (key: string) =>
        key === 'ABBOTT01'
          ? { data: [NOTE, PDF], totalResults: 2, lastModifiedVersion: 1 }
          : { data: [], totalResults: 0, lastModifiedVersion: 1 },
      ),
    },
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    ...over,
  } as never;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'zoteus-zotero-'));
  await mkdir(join(dataDir, 'storage', 'ATTPDF01'), { recursive: true });
  await writeFile(join(dataDir, 'storage', 'ATTPDF01', 'abbott.pdf'), '%PDF-1.4');
});
afterAll(() => rm(dataDir, { recursive: true, force: true }));

describe('itemCitekey', () => {
  it('prefers the native field and falls back to the Citation Key line in extra', () => {
    expect(itemCitekey(ABBOTT)).toBe('abbottSynapticDepressionCortical1997');
    expect(itemCitekey(LEGACY)).toBe('oldReport1999');
    expect(itemCitekey({ data: { extra: 'nothing here' } })).toBeUndefined();
  });
});

describe('zotero_citekeys', () => {
  it('refuses an empty request', async () => {
    const res = await citekeys.handler({}, ctx());
    expect(res.isError).toBe(true);
  });

  it('resolves citekeys to items with their attachments and local paths, and names the missing ones', async () => {
    const res = await citekeys.handler(
      { citekeys: ['abbottSynapticDepressionCortical1997', 'noSuchKey2099', 'oldReport1999'] },
      ctx(),
    );
    const s = res.structuredContent as any;
    expect(s.keys).toHaveLength(3);
    expect(s.keys[0]).toMatchObject({ citekey: 'abbottSynapticDepressionCortical1997', found: true, itemKey: 'ABBOTT01', itemType: 'journalArticle' });
    // Only attachments, not the note; with the storage path resolved.
    expect(s.keys[0].attachments).toHaveLength(1);
    expect(s.keys[0].attachments[0]).toMatchObject({
      key: 'ATTPDF01',
      filename: 'abbott.pdf',
      localPath: join(dataDir, 'storage', 'ATTPDF01', 'abbott.pdf'),
      localPathExists: true,
    });
    expect(s.keys[1]).toEqual({ citekey: 'noSuchKey2099', found: false });
    expect(s.keys[2]).toMatchObject({ found: true, itemKey: 'LEGACY01' });
    expect(s.missing).toEqual(['noSuchKey2099']);
    expect((res.content?.[0] as any).text).toContain('2 of 3 citekey(s) found; missing: noSuchKey2099');
    expect(s.provenance?.source).toBe('library-content');
  });

  it('matches the key exactly rather than any quick-search hit', async () => {
    const res = await citekeys.handler({ citekeys: ['smith2020'], include_attachments: false }, ctx());
    const s = res.structuredContent as any;
    expect(s.keys[0]).toMatchObject({ found: true, itemKey: 'SMITH001' });
    expect(s.keys[0].attachments).toBeUndefined();
    const miss = (await citekeys.handler({ citekeys: ['Smith2020'] }, ctx())).structuredContent as any;
    expect(miss.keys[0].found).toBe(false);
  });

  it('maps item keys to citekeys in one lookup, null for an item without one', async () => {
    const c = ctx();
    const res = await citekeys.handler({ item_keys: ['ABBOTT01', 'LEGACY01', 'GONE0000'] }, c);
    const s = res.structuredContent as any;
    expect((c as any).router.searchItems).toHaveBeenCalledTimes(1);
    expect((c as any).router.searchItems).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: 'ABBOTT01,LEGACY01,GONE0000', limit: 50 }),
    );
    expect(s.items).toEqual([
      { itemKey: 'ABBOTT01', found: true, citekey: 'abbottSynapticDepressionCortical1997', title: 'Synaptic depression and cortical gain control' },
      { itemKey: 'LEGACY01', found: true, citekey: 'oldReport1999', title: 'Old report' },
      { itemKey: 'GONE0000', found: false, citekey: null },
    ]);
  });

  it('gives a remote caller attachments without paths', async () => {
    const res = await citekeys.handler({ citekeys: ['abbottSynapticDepressionCortical1997'] }, ctx({ remoteCaller: true }));
    const att = (res.structuredContent as any).keys[0].attachments[0];
    expect(att.key).toBe('ATTPDF01');
    expect(att.localPath).toBeUndefined();
  });

  it('forwards an explicit library to every read', async () => {
    const c = ctx();
    await citekeys.handler({ citekeys: ['smith2020'], library_type: 'group', library_id: 42 }, c);
    expect((c as any).router.searchItems).toHaveBeenCalledWith(expect.objectContaining({ library: { type: 'group', id: 42 } }));
    expect((c as any).router.getItemChildren).toHaveBeenCalledWith('SMITH001', { library: { type: 'group', id: 42 } });
  });
});
