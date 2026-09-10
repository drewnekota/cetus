/** Split the leading Markdown quote used by the composer from the message body. */
export function splitLeadingQuote(text: string): { quote: string; text: string } | null {
  const lines = text.split("\n");
  let end = 0;
  while (end < lines.length && /^>(\s|$)/.test(lines[end])) end++;
  if (end === 0) return null;
  const quote = lines
    .slice(0, end)
    .map((line) => line.replace(/^> ?/, ""))
    .join("\n")
    .trim();
  if (!quote) return null;
  return { quote, text: lines.slice(end).join("\n").trim() };
}
