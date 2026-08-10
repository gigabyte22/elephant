import { Jimp } from 'jimp';
import { describe, expect, it } from 'vitest';
import { prepareImageForVision } from '../../src/adapters/extraction/image-preprocess.ts';

const OPTS = { maxDim: 1024, quality: 80 };

// Fixtures are generated rather than committed: the repo keeps no binary
// fixtures, and jimp is already a dependency of the code under test.
async function makeImage(
  width: number,
  height: number,
  mime: 'image/jpeg' | 'image/png' | 'image/bmp',
): Promise<Buffer> {
  const img = new Jimp({ width, height, color: 0x3366ccff });
  return Buffer.from(await img.getBuffer(mime));
}

describe('prepareImageForVision', () => {
  it('downscales an oversized photo to maxDim and normalises to JPEG', async () => {
    const big = await makeImage(3072, 4080, 'image/jpeg');
    const out = await prepareImageForVision(big, 'image/jpeg', OPTS);

    expect(out).not.toBeNull();
    expect(out?.mimeType).toBe('image/jpeg');
    const decoded = await Jimp.read(out!.data);
    expect(Math.max(decoded.bitmap.width, decoded.bitmap.height)).toBe(1024);
    // Aspect ratio preserved (3072/4080 → 771/1024).
    expect(decoded.bitmap.width).toBe(771);
    expect(out!.data.length).toBeLessThan(big.length);
  });

  it('passes an already-small image through byte-identically', async () => {
    const small = await makeImage(64, 48, 'image/png');
    const out = await prepareImageForVision(small, 'image/png', OPTS);

    expect(out?.mimeType).toBe('image/png');
    // Re-encoding a small image would cost quality for nothing.
    expect(Buffer.compare(out!.data, small)).toBe(0);
  });

  it('normalises a decodable but provider-unfriendly format even when small', async () => {
    const bmp = await makeImage(32, 32, 'image/bmp');
    const out = await prepareImageForVision(bmp, 'image/bmp', OPTS);

    expect(out?.mimeType).toBe('image/jpeg');
  });

  it.each(['image/svg+xml', 'image/heic', 'image/heif', 'image/avif'])(
    'returns null for %s so the caller skips instead of calling a model',
    async (mime) => {
      const anything = await makeImage(10, 10, 'image/png');
      expect(await prepareImageForVision(anything, mime, OPTS)).toBeNull();
    },
  );

  it('forwards undecodable-but-provider-readable bytes unchanged (webp)', async () => {
    // jimp 1.6 has no webp decoder, but ollama and Anthropic read it natively.
    const junk = Buffer.from('RIFF....WEBPVP8 not really');
    const out = await prepareImageForVision(junk, 'image/webp', OPTS);

    expect(out?.mimeType).toBe('image/webp');
    expect(Buffer.compare(out!.data, junk)).toBe(0);
  });

  it('returns null for undecodable bytes in a format providers cannot read either', async () => {
    const junk = Buffer.from('not an image at all');
    expect(await prepareImageForVision(junk, 'image/tiff', OPTS)).toBeNull();
  });

  it('tolerates a parameterised or upper-case MIME type', async () => {
    const png = await makeImage(20, 20, 'image/png');
    expect(await prepareImageForVision(png, 'IMAGE/PNG; charset=binary', OPTS)).not.toBeNull();
    expect(await prepareImageForVision(png, 'Image/SVG+XML', OPTS)).toBeNull();
  });
});
