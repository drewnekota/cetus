// Non-image attachments can't ride pi's `images` channel (the model only sees
// text + images), so cetus writes each file to disk (save_attachment) and tells
// the model where it landed by appending a delimited reference block to the
// prompt. The block is machine-delimited so the reducer can strip it back off
// the *displayed* user bubble on reload (see stripAttachmentRefs), keeping the
// bubble clean while the model still got the paths.

export const ATTACHMENT_OPEN = "<cetus-attachments>";
export const ATTACHMENT_CLOSE = "</cetus-attachments>";

export interface OutgoingFile {
  name: string;
  path: string;
}

/** The block appended to the prompt text sent to pi (not shown in the bubble). */
export function buildAttachmentRefs(files: OutgoingFile[]): string {
  if (files.length === 0) return "";
  const lines = files.map((f) => `- ${f.name} → ${f.path}`).join("\n");
  return (
    `\n\n${ATTACHMENT_OPEN}\n` +
    `The user attached these files. Use the read_document tool on each path to read them:\n` +
    `${lines}\n${ATTACHMENT_CLOSE}`
  );
}

/** Remove the appended reference block from a reloaded user message's text. */
export function stripAttachmentRefs(text: string): string {
  const open = text.indexOf(ATTACHMENT_OPEN);
  if (open === -1) return text;
  const close = text.indexOf(ATTACHMENT_CLOSE, open);
  if (close === -1) return text;
  const before = text.slice(0, open);
  const after = text.slice(close + ATTACHMENT_CLOSE.length);
  return (before.replace(/\n+$/, "") + after).trim();
}
