// Strips markdown chrome from AI responses for clean display.
// Intentionally conservative: preserves bullet structure and code spans,
// removes only the "noise" characters the user flagged (#, —) plus the
// most common markdown emphasis markers.

export function cleanResponse(text: string): string {
  if (!text) return text;
  return text
    // Strip leading "#" markers from headers, keep the heading text.
    .replace(/^#+\s*/gm, "")
    // Strip blockquote markers at line start.
    .replace(/^>\s*/gm, "")
    // Strip bold markers (keep inner text).
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    // Strip italic markers (keep inner text). Use a non-greedy match and
    // require non-asterisk content so we don't eat bullet "* item".
    .replace(/(^|\W)\*([^*\n]+?)\*(?=\W|$)/g, "$1$2")
    // Em-dash and en-dash → standard hyphen with surrounding spaces.
    .replace(/\s*—\s*/g, " - ")
    .replace(/–/g, "-")
    // Collapse any run of >2 blank lines to a single blank line.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
