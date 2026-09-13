import { callMCPTool } from '../runtime.js';

/**
 * Resolve Better BibTeX citation keys — Look up Better BibTeX citation keys in both directions, for a manuscript that cites with `[@key]`. Give `citekeys` to check which keys exist in the library and which item each one is (key, title, item type), with that item's attachments and their local file paths (`include_attachments`, default true) so a PDF can be handed to another program by citekey; a key that is absent is reported with `found: false` rather than guessed. Give `item_keys` to get the citation key of each item, for adding a citation to the manuscript. Keys are matched exactly and case-sensitively against the item's `citation
 * Params: citekeys, item_keys, include_attachments, library_type, library_id.
 */
export function citekeys(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_citekeys', input);
}
