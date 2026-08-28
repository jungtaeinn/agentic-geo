import { fetchWithTimeout, IMAGE_DOWNLOAD_TIMEOUT_MS, responseErrorSuffix } from "./shared";

/**
 * Tall PDP detail images (e.g. 860x20000px) are downscaled by vision models to
 * their longest-edge limit (GPT-family ~2048px, Claude ~1568px), which crushes
 * body copy below legibility. This module probes image dimensions from the
 * first bytes and, for tall images, cuts vertical slices with an overlap so
 * every text row is seen at usable resolution. Slice OCR results are rejoined
 * downstream by the overlap-aware merge in agent.ts (joinOverlappingOcrTexts).
 */

/** Aspect ratio (height/width) above which an image is considered a tall scroll image. */
const TALL_IMAGE_ASPECT_RATIO = 3;
/** Only slice when the height actually exceeds what vision models keep un-downscaled. */
const TALL_IMAGE_MIN_HEIGHT_PX = 2048;
/** Target slice height in pixels (research guidance: 1200-1500px per slice). */
const SLICE_HEIGHT_PX = 1400;
/** Overlap between adjacent slices so boundary sentences appear in both. */
const SLICE_OVERLAP_RATIO = 0.15;
/** Upper bound on slices per image to keep request cost bounded (covers ~24,000px). */
const MAX_SLICES_PER_IMAGE = 20;
/** Ranged probe size: enough for PNG IHDR, GIF/WebP headers, and JPEG SOF after EXIF blocks. */
const DIMENSION_PROBE_BYTES = 262_144;
/** Full-download cap for slicing; tall marketing PNGs can be large. */
const MAX_SLICE_SOURCE_BYTES = 25 * 1024 * 1024;

/** One image payload sent to a vision provider: prompt/mapping label vs actual input. */
export interface ImageOcrInput {
  /** Stable label used in prompts and result mapping (may carry a #ocr-slice fragment). */
  displayUrl: string;
  /** What the model actually reads: the remote URL or a base64 data URL slice. */
  inputUrl: string;
}

export interface PreparedImageOcrInputs {
  inputs: ImageOcrInput[];
  sliced: boolean;
  /** Set when a tall image was detected but slicing could not run (e.g. sharp unavailable). */
  slicingUnavailableReason?: string;
}

const SLICE_FRAGMENT_PATTERN = /#ocr-slice-\d+of\d+$/;

/** Builds the display URL for one slice of a tall image. */
export function sliceDisplayUrl(imageUrl: string, sliceIndex: number, totalSlices: number): string {
  return `${imageUrl}#ocr-slice-${sliceIndex}of${totalSlices}`;
}

/** Removes the slice fragment so merged OCR evidence points at the original image. */
export function stripSliceFragment(displayUrl: string): string {
  return displayUrl.replace(SLICE_FRAGMENT_PATTERN, "");
}

/**
 * Prepares provider inputs for one OCR target. Non-tall images (or anything
 * that cannot be probed) pass through untouched as their remote URL, so this
 * never makes an image less extractable than before.
 */
export async function prepareImageOcrInputs(imageUrl: string): Promise<PreparedImageOcrInputs> {
  const passthrough: PreparedImageOcrInputs = {
    inputs: [{ displayUrl: imageUrl, inputUrl: imageUrl }],
    sliced: false
  };

  let dimensions: ImageDimensions | undefined;
  try {
    dimensions = await probeRemoteImageDimensions(imageUrl);
  } catch {
    return passthrough;
  }

  if (!dimensions || !isTallImage(dimensions)) {
    return passthrough;
  }

  try {
    const slices = await sliceTallImage(imageUrl, dimensions);
    if (slices.length < 2) {
      return passthrough;
    }
    return {
      inputs: slices.map((dataUrl, index) => ({
        displayUrl: sliceDisplayUrl(imageUrl, index + 1, slices.length),
        inputUrl: dataUrl
      })),
      sliced: true
    };
  } catch (error) {
    return {
      ...passthrough,
      slicingUnavailableReason: error instanceof Error ? error.message : String(error)
    };
  }
}

export interface ImageDimensions {
  width: number;
  height: number;
}

function isTallImage(dimensions: ImageDimensions): boolean {
  return dimensions.width > 0
    && dimensions.height > TALL_IMAGE_MIN_HEIGHT_PX
    && dimensions.height / dimensions.width > TALL_IMAGE_ASPECT_RATIO;
}

/** Downloads the first bytes of an image and parses its dimensions from the header. */
async function probeRemoteImageDimensions(imageUrl: string): Promise<ImageDimensions | undefined> {
  const response = await fetchWithTimeout(imageUrl, {
    headers: {
      Range: `bytes=0-${DIMENSION_PROBE_BYTES - 1}`,
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
    }
  }, IMAGE_DOWNLOAD_TIMEOUT_MS, "Image dimension probe");

  if (!response.ok) {
    return undefined;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return readImageDimensions(buffer.subarray(0, DIMENSION_PROBE_BYTES));
}

/** Pure-JS dimension parser for PNG, JPEG, GIF, and WebP headers. */
export function readImageDimensions(buffer: Buffer): ImageDimensions | undefined {
  return readPngDimensions(buffer)
    ?? readJpegDimensions(buffer)
    ?? readGifDimensions(buffer)
    ?? readWebpDimensions(buffer);
}

function readPngDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    return undefined;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readJpegDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1] ?? 0;
    // Start-of-frame markers carry dimensions (SOF0-SOF15, excluding DHT/JPG/DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    offset += 2 + buffer.readUInt16BE(offset + 2);
  }

  return undefined;
}

function readGifDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 10 || buffer.toString("ascii", 0, 3) !== "GIF") {
    return undefined;
  }
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function readWebpDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return undefined;
  }

  const format = buffer.toString("ascii", 12, 16);
  if (format === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3)
    };
  }
  if (format === "VP8 ") {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff
    };
  }
  if (format === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }
  return undefined;
}

/** Downloads the full tall image and cuts overlapping vertical slices via sharp. */
async function sliceTallImage(imageUrl: string, dimensions: ImageDimensions): Promise<string[]> {
  const sharp = await loadSharp();
  const source = await downloadImageBuffer(imageUrl);
  const stepPx = Math.max(1, Math.round(SLICE_HEIGHT_PX * (1 - SLICE_OVERLAP_RATIO)));
  const slices: string[] = [];

  for (let sliceIndex = 0; sliceIndex < MAX_SLICES_PER_IMAGE; sliceIndex += 1) {
    const top = sliceIndex * stepPx;
    if (top >= dimensions.height) {
      break;
    }

    const height = Math.min(SLICE_HEIGHT_PX, dimensions.height - top);
    const sliceBuffer = await sharp(source)
      .extract({ left: 0, top, width: dimensions.width, height })
      .jpeg({ quality: 88 })
      .toBuffer();
    slices.push(`data:image/jpeg;base64,${sliceBuffer.toString("base64")}`);

    if (top + height >= dimensions.height) {
      break;
    }
  }

  return slices;
}

type SharpFactory = typeof import("sharp");

let cachedSharp: SharpFactory | undefined;

async function loadSharp(): Promise<SharpFactory> {
  if (cachedSharp) {
    return cachedSharp;
  }
  try {
    const sharpModule = await import("sharp") as { default?: SharpFactory };
    cachedSharp = sharpModule.default ?? (sharpModule as unknown as SharpFactory);
    return cachedSharp;
  } catch (error) {
    throw new Error(`Tall-image slicing needs the optional "sharp" dependency, which failed to load: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function downloadImageBuffer(imageUrl: string): Promise<Buffer> {
  const response = await fetchWithTimeout(imageUrl, {
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
    }
  }, IMAGE_DOWNLOAD_TIMEOUT_MS, "Tall image download for slicing");

  if (!response.ok) {
    throw new Error(`Tall image download failed: ${response.status}${await responseErrorSuffix(response)}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_SLICE_SOURCE_BYTES) {
    throw new Error(`Tall image is too large to slice: ${buffer.byteLength} bytes`);
  }

  return buffer;
}
