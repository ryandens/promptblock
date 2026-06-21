import type { ScanResult } from "./scan.js";

/**
 * Reaction emojis used to show the app's progress and verdict directly on the
 * issue/comment being examined:
 *   eyes — currently scanning this content (transient; removed once a verdict is in)
 *   +1   — scanned and looks clean
 *   -1   — scanned and looks like a prompt-injection attempt
 */
export type Reaction = "eyes" | "+1" | "-1";

/**
 * Side effects the examination needs, injected so the orchestration below can
 * be unit-tested without GitHub's API or the ML model.
 */
export interface ExamineDeps {
  /** Run the prompt-injection scan over a raw body. */
  scan: (body: string, source: string) => Promise<ScanResult>;
  /**
   * Add a reaction to the item under examination (best-effort). Resolves to the
   * created reaction's id so it can later be removed, or undefined if the
   * reaction couldn't be added.
   */
  addReaction: (content: Reaction) => Promise<number | undefined>;
  /** Remove a previously-added reaction by id (best-effort). */
  removeReaction: (id: number) => Promise<void>;
  /** Flag a bad item (label + warning comment). */
  flag: (result: ScanResult) => Promise<void>;
}

/**
 * Examine one issue/comment body: mark it with :eyes: while scanning, then add
 * a verdict reaction (:+1: clean / :-1: flagged) and flag it when bad. The
 * :eyes: is intentionally added before the scan so the reaction shows up while
 * the (async) scan is in flight, and removed once the verdict reaction is in so
 * only the outcome remains. Returns the scan result.
 */
export async function examine(
  deps: ExamineDeps,
  body: string,
  source: string,
): Promise<ScanResult> {
  const eyes = await deps.addReaction("eyes");
  const result = await deps.scan(body, source);
  await deps.addReaction(result.flagged ? "-1" : "+1");
  if (eyes !== undefined) await deps.removeReaction(eyes);
  if (result.flagged) await deps.flag(result);
  return result;
}
