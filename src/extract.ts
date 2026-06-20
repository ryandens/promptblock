/**
 * Utilities for pulling apart the untrusted text in a GitHub issue or comment.
 *
 * The interesting attack surface is content that a human reviewer never sees
 * because GitHub's Markdown renderer drops it, but which an LLM-powered agent
 * that reads the *raw* issue body will happily ingest. The biggest offender is
 * the HTML comment (`<!-- ... -->`): invisible in the rendered issue, fully
 * present in the API payload that an agent reads.
 */

/** A chunk of text extracted from a body, tagged with where it came from. */
export interface ExtractedSegment {
  /** Where in the body this text was found. */
  kind: "visible" | "html-comment";
  /** The raw text of the segment. */
  text: string;
}

const HTML_COMMENT = /<!--([\s\S]*?)-->/g;

/**
 * Split a raw body into its visible text and the text hidden inside HTML
 * comments. Both are returned because both reach an agent — but the hidden
 * portion is the part a human reviewer is blind to, so callers may want to
 * weight or flag it differently.
 */
export function extractSegments(body: string): ExtractedSegment[] {
  const segments: ExtractedSegment[] = [];
  const hidden: string[] = [];

  const visible = body.replace(HTML_COMMENT, (_match, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed) hidden.push(trimmed);
    return " ";
  });

  const visibleTrimmed = visible.trim();
  if (visibleTrimmed) {
    segments.push({ kind: "visible", text: visibleTrimmed });
  }
  for (const text of hidden) {
    segments.push({ kind: "html-comment", text });
  }
  return segments;
}

/** Just the text hidden inside HTML comments, concatenated. */
export function hiddenText(body: string): string {
  return extractSegments(body)
    .filter((s) => s.kind === "html-comment")
    .map((s) => s.text)
    .join("\n\n");
}

/** True if the body contains any non-empty HTML comment. */
export function hasHiddenContent(body: string): boolean {
  HTML_COMMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_COMMENT.exec(body)) !== null) {
    if (match[1].trim()) return true;
  }
  return false;
}
