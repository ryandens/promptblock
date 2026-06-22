import type { Context, Probot } from "probot";
import { examine } from "./examine.js";
import { type ScanResult, scanBody, warmup } from "./scan.js";

const FLAG_LABEL = "possible-prompt-injection";

type IssueEvent = "issues.opened" | "issues.edited";
type CommentEvent = "issue_comment.created" | "issue_comment.edited";

/**
 * Injectable dependencies for the app. Real wiring uses the ML scanner and
 * model warmup; tests substitute lightweight fakes so handler logic (self-skip,
 * reaction lifecycle) can be exercised without loading the model.
 */
export interface AppDeps {
  scan: (body: string, source: string) => Promise<ScanResult>;
  warmup: () => Promise<void>;
}

const defaultDeps: AppDeps = { scan: scanBody, warmup };

/**
 * Build the Probot app. Exported as a factory (rather than only the default
 * export) so tests can inject fake deps.
 */
export function createApp(deps: AppDeps = defaultDeps) {
  return (app: Probot) => {
    // Warm the ML model at boot so the first issue doesn't pay the load cost.
    void deps
      .warmup()
      .catch((err) => app.log.warn({ err }, "scanner warmup failed"));

    app.on(["issues.opened", "issues.edited"], async (context) => {
      const { issue } = context.payload;
      if (await isSelf(context, issue.user?.login)) {
        context.log.debug(
          { issue: issue.number },
          "skipping issue authored by self",
        );
        return;
      }
      const body = `${issue.title ?? ""}\n\n${issue.body ?? ""}`;
      await examine(
        {
          scan: deps.scan,
          addReaction: (content) =>
            postReaction(context, () =>
              context.octokit.rest.reactions.createForIssue({
                ...context.repo(),
                issue_number: issue.number,
                content,
              }),
            ),
          removeReaction: (id) =>
            removeReaction(context, () =>
              context.octokit.rest.reactions.deleteForIssue({
                ...context.repo(),
                issue_number: issue.number,
                reaction_id: id,
              }),
            ),
          flag: (result) => flagIssue(context, result, issue.number),
        },
        body,
        "issue",
      );
    });

    app.on(
      ["issue_comment.created", "issue_comment.edited"],
      async (context) => {
        const { comment, issue } = context.payload;
        if (await isSelf(context, comment.user?.login)) {
          context.log.debug(
            { comment: comment.id },
            "skipping comment authored by self",
          );
          return;
        }
        await examine(
          {
            scan: deps.scan,
            addReaction: (content) =>
              postReaction(context, () =>
                context.octokit.rest.reactions.createForIssueComment({
                  ...context.repo(),
                  comment_id: comment.id,
                  content,
                }),
              ),
            removeReaction: (id) =>
              removeReaction(context, () =>
                context.octokit.rest.reactions.deleteForIssueComment({
                  ...context.repo(),
                  comment_id: comment.id,
                  reaction_id: id,
                }),
              ),
            flag: (result) => flagIssue(context, result, issue.number),
          },
          comment.body ?? "",
          "issue_comment",
        );
      },
    );
  };
}

export default createApp();

/**
 * Cached login of this GitHub App's bot account (e.g. `promptblock[bot]`).
 * Resolved lazily on the first event and reused for the process lifetime, since
 * the app's own identity never changes at runtime.
 */
let selfLogin: string | undefined;

/**
 * Whether the given author is this bot itself. Used to skip issues and comments
 * the app authored — otherwise its own warning comments would re-trigger a scan,
 * and reacting to / flagging its own output is noise at best and a loop at worst.
 *
 * A GitHub App's content is authored by `<slug>[bot]`; we resolve the slug once
 * via the authenticated-app endpoint and compare logins case-insensitively.
 */
async function isSelf(
  context: Context<IssueEvent | CommentEvent>,
  author: string | undefined,
): Promise<boolean> {
  if (!author) return false;
  if (selfLogin === undefined) {
    try {
      const { data } = await context.octokit.rest.apps.getAuthenticated();
      if (!data?.slug) return false;
      selfLogin = `${data.slug}[bot]`;
    } catch (err) {
      // If we can't resolve our own identity, fall back to scanning rather than
      // silently dropping events; a self-scan is a lesser evil than a missed one.
      context.log.warn(
        { err },
        "failed to resolve app identity for self-check",
      );
      return false;
    }
  }
  return author.toLowerCase() === selfLogin.toLowerCase();
}

/**
 * Add a reaction best-effort, returning its id (for later removal). Reactions
 * are progress signals, not the core job, so a failure here (e.g. a transient
 * API error) is logged but must not abort scanning or flagging.
 */
async function postReaction(
  context: Context<IssueEvent | CommentEvent>,
  post: () => Promise<{ data: { id: number } }>,
): Promise<number | undefined> {
  try {
    const { data } = await post();
    return data.id;
  } catch (err) {
    context.log.warn({ err }, "failed to add reaction");
    return undefined;
  }
}

/**
 * Remove a reaction best-effort. Like adding, removing the transient :eyes:
 * marker is cosmetic, so a failure is logged and otherwise ignored.
 */
async function removeReaction(
  context: Context<IssueEvent | CommentEvent>,
  remove: () => Promise<unknown>,
): Promise<void> {
  try {
    await remove();
  } catch (err) {
    context.log.warn({ err }, "failed to remove reaction");
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
    {
      issue: issueNumber,
      hidden: result.hiddenInjection,
      findings: result.findings,
    },
    "prompt injection flagged",
  );

  await context.octokit.rest.issues.addLabels({
    ...repo,
    issue_number: issueNumber,
    labels: [FLAG_LABEL],
  });

  const flagged = result.findings.filter((f) => !f.allowed);
  const lines = flagged.map((f) => {
    const where =
      f.segment.kind === "html-comment"
        ? `hidden HTML comment${
            f.segment.index !== undefined ? ` #${f.segment.index}` : ""
          }`
        : "visible text";
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
