import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../lib/index.js";
import type { ScanResult } from "../lib/scan.js";

const SELF_LOGIN = "promptblock[bot]";

function cleanResult(): ScanResult {
  return { flagged: false, hiddenInjection: false, findings: [] };
}

function flaggedResult(): ScanResult {
  return {
    flagged: true,
    hiddenInjection: false,
    findings: [
      { allowed: false, segment: { kind: "text" }, riskLevel: "high" },
    ],
    // biome-ignore lint/suspicious/noExplicitAny: minimal fixture for the flag path
  } as any;
}

/**
 * Register the app's handlers against a fake Probot, capturing each event's
 * handler and recording whether the injected scanner ran.
 */
function buildApp(
  result: ScanResult,
  options: { authResolves?: boolean } = {},
) {
  const handlers = new Map<string, (ctx: unknown) => Promise<void>>();
  const scanCalls: Array<{ body: string; source: string }> = [];

  const deps = {
    scan: async (body: string, source: string) => {
      scanCalls.push({ body, source });
      return result;
    },
    warmup: async () => {},
  };

  const app = {
    log: { warn() {}, debug() {}, info() {}, error() {} },
    on: (events: string[], fn: (ctx: unknown) => Promise<void>) => {
      for (const event of events) handlers.set(event, fn);
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal Probot stub
  } as any;

  createApp(deps)(app);

  const authResolves = options.authResolves ?? true;

  /** Build a fake webhook context with recording octokit endpoints. */
  function context(payload: unknown) {
    let nextReactionId = 100;
    const created: Array<Record<string, unknown>> = [];
    const deleted: Array<Record<string, unknown>> = [];
    const labels: Array<Record<string, unknown>> = [];
    const comments: Array<Record<string, unknown>> = [];

    const octokit = {
      rest: {
        apps: {
          getAuthenticated: async () => {
            if (!authResolves) throw new Error("no identity");
            return { data: { slug: "promptblock" } };
          },
        },
        reactions: {
          createForIssue: async (args: Record<string, unknown>) => {
            created.push(args);
            return { data: { id: nextReactionId++ } };
          },
          deleteForIssue: async (args: Record<string, unknown>) => {
            deleted.push(args);
          },
          createForIssueComment: async (args: Record<string, unknown>) => {
            created.push(args);
            return { data: { id: nextReactionId++ } };
          },
          deleteForIssueComment: async (args: Record<string, unknown>) => {
            deleted.push(args);
          },
        },
        issues: {
          addLabels: async (args: Record<string, unknown>) => {
            labels.push(args);
          },
          createComment: async (args: Record<string, unknown>) => {
            comments.push(args);
          },
        },
      },
    };

    const ctx = {
      payload,
      log: { warn() {}, debug() {}, info() {}, error() {} },
      octokit,
      repo: () => ({ owner: "o", repo: "r" }),
    };

    return { ctx, created, deleted, labels, comments };
  }

  return { handlers, scanCalls, context };
}

function issuePayload(login: string) {
  return {
    issue: { number: 1, title: "title", body: "body", user: { login } },
  };
}

function commentPayload(login: string) {
  return {
    comment: { id: 5, body: "hello", user: { login } },
    issue: { number: 2 },
  };
}

// Run first so the lazy self-login cache is unresolved when we exercise the
// identity-resolution failure path.
test("falls back to scanning when the app identity cannot be resolved", async () => {
  const app = buildApp(cleanResult(), { authResolves: false });
  const { ctx } = app.context(issuePayload("someone"));
  await app.handlers.get("issues.opened")!(ctx);
  assert.equal(app.scanCalls.length, 1);
});

test("skips an issue authored by the bot itself", async () => {
  const app = buildApp(cleanResult());
  const { ctx, created } = app.context(issuePayload(SELF_LOGIN));
  await app.handlers.get("issues.opened")!(ctx);
  assert.equal(app.scanCalls.length, 0);
  assert.equal(created.length, 0);
});

test("the self-check is case-insensitive", async () => {
  const app = buildApp(cleanResult());
  const { ctx } = app.context(issuePayload("PromptBlock[BOT]"));
  await app.handlers.get("issues.opened")!(ctx);
  assert.equal(app.scanCalls.length, 0);
});

test("scans an issue from a normal user, then clears eyes for the verdict", async () => {
  const app = buildApp(cleanResult());
  const { ctx, created, deleted, labels, comments } = app.context(
    issuePayload("alice"),
  );
  await app.handlers.get("issues.opened")!(ctx);

  assert.equal(app.scanCalls.length, 1);
  assert.deepEqual(app.scanCalls[0], {
    body: "title\n\nbody",
    source: "issue",
  });
  assert.deepEqual(
    created.map((c) => c.content),
    ["eyes", "+1"],
  );
  // The eyes reaction (id 100) is removed; the verdict reaction stays.
  assert.deepEqual(
    deleted.map((d) => d.reaction_id),
    [100],
  );
  assert.equal(labels.length, 0);
  assert.equal(comments.length, 0);
});

test("flags a bad issue and still clears eyes", async () => {
  const app = buildApp(flaggedResult());
  const { ctx, created, deleted, labels, comments } = app.context(
    issuePayload("mallory"),
  );
  await app.handlers.get("issues.opened")!(ctx);

  assert.deepEqual(
    created.map((c) => c.content),
    ["eyes", "-1"],
  );
  assert.deepEqual(
    deleted.map((d) => d.reaction_id),
    [100],
  );
  assert.equal(labels.length, 1);
  assert.equal(comments.length, 1);
});

test("flags hidden comment findings with a stable comment index", async () => {
  const app = buildApp({
    flagged: true,
    hiddenInjection: true,
    findings: [
      {
        allowed: false,
        segment: { kind: "html-comment", text: "redacted", index: 2 },
        riskLevel: "high",
        score: 0.96,
      },
    ],
  });
  const { ctx, comments } = app.context(issuePayload("mallory"));
  const handler = app.handlers.get("issues.opened");
  assert.ok(handler);
  await handler(ctx);

  assert.equal(comments.length, 1);
  assert.match(String(comments[0].body), /hidden HTML comment #2/);
  assert.doesNotMatch(String(comments[0].body), /redacted/);
});

test("skips a comment authored by the bot itself", async () => {
  const app = buildApp(cleanResult());
  const { ctx, created } = app.context(commentPayload(SELF_LOGIN));
  await app.handlers.get("issue_comment.created")!(ctx);
  assert.equal(app.scanCalls.length, 0);
  assert.equal(created.length, 0);
});

test("scans a normal comment via the comment reaction endpoints and clears eyes", async () => {
  const app = buildApp(cleanResult());
  const { ctx, created, deleted } = app.context(commentPayload("bob"));
  await app.handlers.get("issue_comment.created")!(ctx);

  assert.equal(app.scanCalls.length, 1);
  assert.deepEqual(app.scanCalls[0], {
    body: "hello",
    source: "issue_comment",
  });
  // Comment reactions target a comment_id rather than an issue_number.
  assert.deepEqual(
    created.map((c) => c.comment_id),
    [5, 5],
  );
  assert.deepEqual(
    deleted.map((d) => ({
      comment_id: d.comment_id,
      reaction_id: d.reaction_id,
    })),
    [{ comment_id: 5, reaction_id: 100 }],
  );
});
