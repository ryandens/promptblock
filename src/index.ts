import type { Probot, Context } from "probot";
import { scanBody, warmup, type ScanResult } from "./scan.js";
import { examine } from "./examine.js";

const FLAG_LABEL = "possible-prompt-injection";

type IssueEvent = "issues.opened" | "issues.edited";
type CommentEvent = "issue_comment.created" | "issue_comment.edited";

export default (app: Probot) => {
  // Warm the ML model at boot so the first issue doesn't pay the load cost.
  void warmup().catch((err) => app.log.warn({ err }, "scanner warmup failed"));

  app.on(["issues.opened", "issues.edited"], async (context) => {
    const { issue } = context.payload;
    const body = `${issue.title ?? ""}\n\n${issue.body ?? ""}`;
    await examine(
      {
        scan: scanBody,
        addReaction: (content) =>
          postReaction(context, () =>
            context.octokit.rest.reactions.createForIssue({
              ...context.repo(),
              issue_number: issue.number,
              content,
            }),
          ),
        flag: (result) => flagIssue(context, result, issue.number),
      },
      body,
      "issue",
    );
  });

  app.on(["issue_comment.created", "issue_comment.edited"], async (context) => {
    const { comment, issue } = context.payload;
    await examine(
      {
        scan: scanBody,
        addReaction: (content) =>
          postReaction(context, () =>
            context.octokit.rest.reactions.createForIssueComment({
              ...context.repo(),
              comment_id: comment.id,
              content,
            }),
          ),
        flag: (result) => flagIssue(context, result, issue.number),
      },
      comment.body ?? "",
      "issue_comment",
    );
  });
};

/**
 * Post a reaction best-effort. Reactions are progress signals, not the core
 * job, so a failure here (e.g. a transient API error) is logged but must not
 * abort scanning or flagging.
 */
async function postReaction(
  context: Context<IssueEvent | CommentEvent>,
  post: () => Promise<unknown>,
): Promise<void> {
  try {
    await post();
  } catch (err) {
    context.log.warn({ err }, "failed to add reaction");
  }
}

/**
 * Flag a bad issue by labeling it and leaving a single warning comment. We
 * deliberately surface *that* hidden content existed and was flagged, without
 * echoing the raw injection payload back into the thread.
 */
async function flagIssue(
  context: Context<IssueEvent | CommentEvent>,
  result: ScanResult,
  issueNumber: number,
): Promise<void> {
  const repo = context.repo();
  context.log.warn(
    { issue: issueNumber, hidden: result.hiddenInjection, findings: result.findings },
    "prompt injection flagged",
  );

  await context.octokit.rest.issues.addLabels({
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

  await context.octokit.rest.issues.createComment({
    ...repo,
    issue_number: issueNumber,
    body: `🛡️ **promptblock** detected content that resembles a prompt-injection attempt:\n\n${lines.join("\n")}${hiddenNote}\n\n_Review before letting any AI agent act on this thread._`,
  });
}
