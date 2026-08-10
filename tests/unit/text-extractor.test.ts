import { describe, expect, it } from 'vitest';
import { createTextExtractor } from '../../src/adapters/extraction/text-extractor.ts';

const extractor = createTextExtractor({ maxBytes: 1024 });

const extract = (data: Buffer, mimeType = 'text/plain') =>
  extractor.extract({ data, mimeType, filename: 'f' });

describe('createTextExtractor', () => {
  it('decodes UTF-8 with and without a BOM', async () => {
    await expect(extract(Buffer.from('héllo wörld', 'utf8'))).resolves.toMatchObject({
      status: 'done',
      text: 'héllo wörld',
    });
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')]);
    await expect(extract(withBom)).resolves.toMatchObject({ status: 'done', text: 'hello' });
  });

  it('decodes UTF-16 in both byte orders rather than storing NUL-riddled mojibake', async () => {
    // Decoded as UTF-8 this is "h\0e\0l\0l\0o\0" — indexed, unsearchable, and
    // indistinguishable from a corrupt upload once it is in the graph.
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello', 'utf16le')]);
    await expect(extract(le)).resolves.toMatchObject({ status: 'done', text: 'hello' });

    const be = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from(Buffer.from('hello', 'utf16le')).swap16(),
    ]);
    await expect(extract(be)).resolves.toMatchObject({ status: 'done', text: 'hello' });
  });

  it('skips binary content mislabelled as text instead of indexing the garbage', async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    await expect(extract(png)).resolves.toMatchObject({
      status: 'skipped',
      text: '',
      detail: 'binary content labelled text/plain',
    });
  });

  it('truncates past the byte cap and says so', async () => {
    const big = Buffer.from('a'.repeat(4096), 'utf8');
    const result = await extract(big);
    expect(result.status).toBe('truncated');
    expect(result.text).toHaveLength(1024);
    expect(result.detail).toBe('read the first 1024 of 4096 bytes');
  });

  it('cuts the truncation at a whole code point', async () => {
    // 512 two-byte characters exactly fills the cap; a naive byte slice one
    // short would split the last one and yield U+FFFD.
    const data = Buffer.from('é'.repeat(600), 'utf8');
    const result = await extract(data);
    expect(result.status).toBe('truncated');
    expect(result.text).toBe('é'.repeat(512));
  });

  it('strips tags and decodes named and numeric entities in HTML', async () => {
    const html = Buffer.from(
      '<style>p{color:red}</style><p>Ren&#233;&#8217;s caf&eacute; &amp; bar</p><script>x()</script>',
      'utf8',
    );
    await expect(extract(html, 'text/html')).resolves.toMatchObject({
      status: 'done',
      // &eacute; is not in the decode table and stays literal — the numeric
      // forms, which are what real pages emit, do not.
      text: 'René’s caf&eacute; & bar',
    });
  });

  it('reports empty for whitespace-only input', async () => {
    await expect(extract(Buffer.from('   \n\t ', 'utf8'))).resolves.toMatchObject({
      status: 'empty',
      text: '',
    });
  });
});
