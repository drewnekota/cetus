const MAX_IMAGE_EDGE = 2000;
// Keep the encoded payload below the strictest runtime's inline-image budget.
// This is a processing target, not an upload limit: larger source images are
// accepted and optimized before they are attached.
const MAX_BASE64_BYTES = Math.floor(4.5 * 1024 * 1024);

export interface PreparedImage {
  data: string;
  mimeType: string;
  previewBlob: Blob;
}

export async function prepareImageAttachment(file: File): Promise<PreparedImage> {
  const bitmap = await decodeImage(file);
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    if (
      scale === 1 &&
      Math.ceil(file.size / 3) * 4 <= MAX_BASE64_BYTES &&
      isInlineImageType(file.type)
    ) {
      return { data: await blobToBase64(file), mimeType: file.type, previewBlob: file };
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("image canvas unavailable");

    let targetWidth = width;
    let targetHeight = height;
    while (true) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      // JPEG is understood by every runtime. Fill transparency explicitly so
      // it does not become black when PNG/WebP sources are flattened.
      context.fillStyle = "#fff";
      context.fillRect(0, 0, targetWidth, targetHeight);
      context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

      let blob = await canvasToBlob(canvas, 0.88);
      for (const quality of [0.78, 0.68, 0.58, 0.48, 0.4]) {
        if (encodedSize(blob) <= MAX_BASE64_BYTES) break;
        blob = await canvasToBlob(canvas, quality);
      }
      if (encodedSize(blob) <= MAX_BASE64_BYTES || (targetWidth === 1 && targetHeight === 1)) {
        return { data: await blobToBase64(blob), mimeType: "image/jpeg", previewBlob: blob };
      }
      targetWidth = Math.max(1, Math.round(targetWidth * 0.8));
      targetHeight = Math.max(1, Math.round(targetHeight * 0.8));
    }
  } finally {
    bitmap.close();
  }
}

function isInlineImageType(type: string): boolean {
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(type);
}

async function decodeImage(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`Could not decode image: ${file.name || "image"}`);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Could not optimize image")),
      "image/jpeg",
      quality,
    );
  });
}

function encodedSize(blob: Blob): number {
  return Math.ceil(blob.size / 3) * 4;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}
