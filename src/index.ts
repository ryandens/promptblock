import type { Probot, Context } from "probot";
import { scanBody, warmup, type ScanResult } from "./scan.js";

const FLAG_LABEL = "possible-prompt-injection";

export default (app: Probot) => {
  // Warm the ML model at boot so the first issue doesn't pay the load cost.
  void warmup().catch((err) => app.log.warn({ err }, "defender warmup failed"));

  app.on(["issues.opened", "issues.edited"], async (context) => {
    const { issue } = context.payload;
    const body = `${issue.title ?? ""}\n\n${issue.body ?? ""}`;
    const result = await scanBody(body, "issue");
    await react(context, result, issue.number);
  });

  app.on(["issue_comment.created", "issue_comment.edited"], async (context) => {
    const { comment, issue } = context.payload;
    const result = await scanBody(comment.body ?? "", "issue_comment");
    await react(context, result, issue.number);
  });
};

/**
 * React to a scan result by labeling the issue and leaving a single warning
 * comment. We deliberately surface *that* hidden content existed and was
 * flagged, without echoing the raw injection payload back into the thread.
 */
async function react(
  context: Context<"issues.opened" | "issues.edited" | "issue_comment.created" | "issue_comment.edited">,
  result: ScanResult,
  issueNumber: number,
): Promise<void> {
  if (!result.flagged) return;

  const repo = context.repo();
  context.log.warn(
    { issue: issueNumber, hidden: result.hiddenInjection, findings: result.findings },
    "prompt injection flagged",
  );

  await context.octokit.issues.addLabels({
    ...repo,
    issue_number: issueNumber,
    labels: [FLAG_LABEL],
  });

  const flagged = result.findings.filter((f) => !f.allowed);
  const lines = flagged.map((f) => {
    const where = f.segment.kind === "html-comment" ? "hidden HTML comment" : "visible text";
    const score = f.score !== undefined ? `, score ${f.score.toFixed(2)}` : "";
    return `- **${where}** — risk \`${f.riskLevel}\`${score}`;
  });

  const hiddenNote = result.hiddenInjection
    ? "\n\n> ⚠️ At least one flagged segment was hidden inside an HTML comment and is **not visible** in the rendered issue. An automated agent reading the raw text would still ingest it."
    : "";

  await context.octokit.issues.createComment({
    ...repo,
    issue_number: issueNumber,
    body: `🛡️ **promptblock** detected content that resembles a prompt-injection attempt:\n\n${lines.join("\n")}${hiddenNote}\n\n_Scanned with [@stackone/defender](https://github.com/StackOneHQ/defender). Review before letting any AI agent act on this thread._`,
  });
}
