/** Game text helpers with no Node dependencies (shared by the report and the browser killfeed tool). */

/** Remove CoD color codes (^0..^9). */
export function stripColors(s: string): string {
  return s.replace(/\^[0-9]/g, "");
}

/**
 * Render a game message. Text segments are marked with 0x15, localized keys with 0x14.
 * A message that starts with a bare key ("MP_CONNECTED\x15Name") uses the rest as its &&1, &&2... parameters.
 * Color codes are kept unless `strip` is set.
 */
export function renderMessage(raw: string, loc: Map<string, string>, strip = true): { text: string; key: string } {
  const parts = raw.split(/([\x14\x15])/);
  const segments: { key: boolean; value: string }[] = [];
  if (parts[0]) segments.push({ key: /^[A-Z][A-Z0-9_]+$/.test(parts[0]), value: parts[0] });
  for (let i = 1; i < parts.length; i += 2) segments.push({ key: parts[i] === "\x14", value: parts[i + 1] ?? "" });
  const show = (s: { key: boolean; value: string }) => (s.key ? (loc.get(s.value) ?? s.value) : s.value);
  const clean = (s: string) => (strip ? stripColors(s) : s).trim();

  const first = segments[0];
  if (first?.key && parts[0]) {
    const params = segments.slice(1).map(show);
    let text = loc.get(first.value) ?? first.value;
    if (/&&\d/.test(text)) text = text.replace(/&&(\d)/g, (_, n) => params[Number(n) - 1] ?? "");
    else if (params.length) text += " " + params.join(" ");
    return { text: clean(text), key: first.value };
  }
  return { text: clean(segments.map(show).join("")), key: segments.find((s) => s.key)?.value ?? "" };
}

/** Argument of a server command like `f "..."`, without the quotes. */
export function commandArg(text: string): string {
  const a = text.slice(2).trim();
  return a.startsWith('"') && a.endsWith('"') ? a.slice(1, -1) : a;
}
