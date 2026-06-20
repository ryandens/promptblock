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
