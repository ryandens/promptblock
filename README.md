<p align="center">
  <img src="docs/logo.png" alt="promptblock logo" width="320" />
</p>

# promptblock

A GitHub App that scans issues and comments for **prompt-injection attempts**
using a bundled, ML-based prompt-injection classifier.

Its particular focus is content that a human reviewer never sees but an
AI agent does: **text hidden inside HTML comments** (`<!-- ... -->`). GitHub's
Markdown renderer drops these, so they're invisible in the rendered issue — but
any agent that reads the raw issue body (via the REST/GraphQL API) ingests them
in full. That makes the HTML comment an ideal smuggling channel for injection
payloads.

## How it works

1. On `issues` and `issue_comment` events, the raw body is split into
   **visible text** and each **HTML comment** (`src/extract.ts`).
2. Every segment is scanned independently through the scanner's tiered cascade
   (`src/scan.ts`) so a benign visible body can't mask a malicious hidden one.
3. If anything is flagged, the app labels the issue `possible-prompt-injection`
   and leaves one warning comment — calling out specifically when the offending
   content was **hidden** (`src/index.ts`).

The app never echoes the raw injection payload back into the thread; it reports
*where* and *how risky*, not the verbatim attack string.

## Install

The hosted app lives at **<https://github.com/apps/promptblock>**.

1. Open <https://github.com/apps/promptblock> and click **Install** (or
   **Configure** if it's already installed).
2. Choose the account or organization to install it on.
3. Pick the repositories to protect — **All repositories** or a hand-picked
   **Only select repositories** list. You can change this selection any time
   from the same page.
4. Confirm. promptblock starts scanning new issues and comments on the selected
   repos immediately; nothing else to configure.

The app requests only the permissions it needs: **read & write** on issues (to
add the `possible-prompt-injection` label and warning comment) and **read** on
metadata. It subscribes to the `issues` and `issue_comment` webhook events.

To stop it, open the same page and either deselect repositories or uninstall it
under **Settings → Applications → Installed GitHub Apps** on your account/org.

> Prefer to run your own instance instead of the hosted app? See
> [Deploy](#deploy) to self-host it from the bundled Docker image.

## Develop

This project uses [pnpm](https://pnpm.io) (pinned via the `packageManager`
field; run `corepack enable` once to activate it).

```bash
pnpm install
pnpm build
pnpm test          # runs the extraction unit tests
pnpm start         # runs the app (needs a .env — see .env.example)
```

To register the app against GitHub, run `pnpm start` once and follow the
manifest registration flow (the manifest lives in `app.yml`), or create the app
manually and fill in `.env` from `.env.example`.

### Testing webhooks locally

GitHub can't reach `localhost`, so local development forwards webhook
deliveries through a [smee.io](https://smee.io) proxy. The
[`smee-client`](https://github.com/probot/smee-client) is bundled as a
dev dependency, and Probot connects it automatically when `WEBHOOK_PROXY_URL`
is set.

```bash
pnpm smee:new      # provisions a fresh smee.io channel and prints the URL
```

Paste the printed URL into `.env` as `WEBHOOK_PROXY_URL=...` and set the GitHub
App's webhook URL (Settings → Advanced) to the same value. Then:

```bash
pnpm start
```

Probot starts the local server *and* the smee client, forwarding every GitHub
delivery to `http://localhost:3000/api/github/webhooks`. Open an issue (or edit
a comment) on a repo the app is installed on to exercise the scanner end to end.

Dependency installs are subject to a supply-chain policy in
`pnpm-workspace.yaml`: no package version is installed until it has been public
for at least 5 days (`minimumReleaseAge`), and no package may run install/build
scripts (`onlyBuiltDependencies: []`). Tests run on Node's built-in TypeScript
support, so the dependency tree needs no build step.

## Deploy

A multi-stage `Dockerfile` is included:

```bash
docker build -t promptblock .
docker run -p 3000:3000 \
  -e APP_ID=... -e WEBHOOK_SECRET=... -e PRIVATE_KEY="$(cat private-key.pem)" \
  promptblock
```

Point the GitHub App's webhook URL at the running container (use a smee.io proxy
locally). The image bundles the scanner's ~22MB ONNX model, so no download
happens at runtime.

CI (`.github/workflows/ci.yml`) runs typecheck, build, and tests on every push
and pull request to `main`.

## License

[Apache 2.0](./LICENSE)
