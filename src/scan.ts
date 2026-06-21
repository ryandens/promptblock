import { createPromptDefense } from "@stackone/defender";
import { type ExtractedSegment, extractSegments } from "./extract.js";

/**
 * Wraps the prompt-injection scanner so the rest of the app can scan a raw
 * issue/comment body without caring about how the body is segmented. Each
 * segment (visible text and each HTML comment) is scanned independently so a
 * clean visible body can't dilute a malicious hidden payload.
 */

// One shared defense instance — it lazily loads a ~22MB ONNX model on first
// Tier 2 call, so we keep it alive for the lifetime of the process.
const defense = createPromptDefense({ blockHighRisk: true });

export interface SegmentFinding {
  segment: ExtractedSegment;
  /** Whether the scanner would allow this content through to an LLM. */
  allowed: boolean;
  /** "low" | "medium" | "high" risk taxonomy. */
  riskLevel: string;
  /** Tier 2 ML classifier score, when present. */
  score?: number;
}

export interface ScanResult {
  /** True if any segment was flagged as not-allowed. */
  flagged: boolean;
  /** True if the offending content came from a hidden HTML comment. */
  hiddenInjection: boolean;
  findings: SegmentFinding[];
}

/** Pre-load the Tier 2 model so the first real webhook isn't slow. */
export async function warmup(): Promise<void> {
  await defense.warmupTier2();
}

/**
 * Scan a raw body. `source` is passed to the scanner as the "tool name" so its
 * logs/telemetry attribute the content to where it came from.
 */
export async function scanBody(
  body: string,
  source: string,
): Promise<ScanResult> {
  const segments = extractSegments(body);
  const findings: SegmentFinding[] = [];

  for (const segment of segments) {
    const label =
      segment.kind === "html-comment" ? `${source}:html-comment` : source;
    const result = await defense.defendToolResult(segment.text, label);
    findings.push({
      segment,
      allowed: result.allowed,
      riskLevel: result.riskLevel,
      score: result.tier2Score,
    });
  }

  const flaggedFindings = findings.filter((f) => !f.allowed);
  return {
    flagged: flaggedFindings.length > 0,
    hiddenInjection: flaggedFindings.some(
      (f) => f.segment.kind === "html-comment",
    ),
    findings,
  };
}
