// Shrinks images before they are handed to a vision model.
//
// Vision cost is dominated by prefill, which scales with pixel count: a 12 MP
// phone photo costs minutes of GPU on a local model while its 1024px downscale
// transcribes just as accurately in a fraction of the time. Resizing here rather
// than at ingestion keeps the blob store holding pristine originals (thumbnails
// and downloads depend on that) and means every extraction path — upload, async
// worker, backfill — inherits the same treatment.
//
// Secondary benefit: anything this re-encodes comes out as JPEG, one of the four
// media types the Anthropic path can declare, so the cast there stays honest.

import { Jimp } from 'jimp';

export interface PrepareOptions {
  /** Longest edge in px. Images within this are passed through untouched. */
  maxDim: number;
  /** JPEG quality for re-encodes. */
  quality: number;
}

export interface PreparedImage {
  data: Buffer;
  mimeType: string;
}

// Formats jimp cannot decode. SVG is also a script-capable vector format that no
// raster vision pipeline should be fed, and heic/heif/avif are phone/modern
// codecs jimp has no decoder for.
const UNDECODABLE = new Set(['image/svg+xml', 'image/heic', 'image/heif', 'image/avif']);

// Formats a vision provider accepts directly, so an undecodable-by-jimp file can
// still be forwarded as-is. webp is the important one: jimp 1.6 cannot decode it
// but both ollama and Anthropic read it natively.
const PROVIDER_READABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// jimp exports no image type of its own; this is what Jimp.read resolves to.
type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

/**
 * Returns bytes ready for a vision model, or `null` when the format cannot be
 * read by anything downstream (caller should record 'skipped', not call a model).
 */
export async function prepareImageForVision(
  data: Buffer,
  mimeType: string,
  opts: PrepareOptions,
): Promise<PreparedImage | null> {
  const mime = mimeType.split(';')[0]!.trim().toLowerCase();
  if (UNDECODABLE.has(mime)) return null;

  let image: JimpImage;
  try {
    image = await Jimp.read(data);
  } catch {
    // Undecodable here, but the provider may still cope (webp). Otherwise this
    // is genuinely unreadable — a mislabelled or corrupt file.
    return PROVIDER_READABLE.has(mime) ? { data, mimeType: mime } : null;
  }

  const { width, height } = image.bitmap;
  const longest = Math.max(width, height);
  if (longest > opts.maxDim) {
    const scale = opts.maxDim / longest;
    image.resize({ w: Math.round(width * scale), h: Math.round(height * scale) });
    return { data: await toJpeg(image, opts.quality), mimeType: 'image/jpeg' };
  }

  // Small enough to skip the resize. Hand back the original bytes when a
  // provider reads them — re-encoding would spend a generation of JPEG loss for
  // nothing — and otherwise normalise the format alone (bmp/tiff).
  if (PROVIDER_READABLE.has(mime)) return { data, mimeType: mime };
  return { data: await toJpeg(image, opts.quality), mimeType: 'image/jpeg' };
}

async function toJpeg(image: JimpImage, quality: number): Promise<Buffer> {
  const out = await image.getBuffer('image/jpeg', { quality });
  return Buffer.from(out);
}
