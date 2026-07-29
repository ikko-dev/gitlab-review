# @weareikko/code-review

[![NPM Version](https://img.shields.io/npm/v/@weareikko/code-review.svg?style=flat&colorB=3e63dd&colorA=414853)](https://www.npmjs.com/package/@weareikko/code-review/)
[![Downloads](https://img.shields.io/npm/dm/@weareikko/code-review?style=flat&colorB=3e63dd&colorA=414853)](https://www.npmjs.com/package/@weareikko/code-review/)
[![Size](https://img.shields.io/bundlephobia/minzip/@weareikko/code-review?style=flat&colorB=3e63dd&colorA=414853&label=size)](https://bundlephobia.com/package/@weareikko/code-review)
![Codecov](https://img.shields.io/codecov/c/github/weareikko/code-review?style=flat&colorB=3e63dd&colorA=414853)

Run an agent-driven code review on **GitLab merge requests and GitHub pull requests** — the same review engine on both. It parses inline comments, posts deduplicated review discussions, upserts a summary, and reports per-run token usage and cost. The platform is auto-detected from the environment (GitLab CI vs. GitHub Actions) and can be forced with `--platform github|gitlab`.

The reviewer reads the merge/pull request **title and description** as the author's declared intent: it reads the diff against the stated purpose and surfaces code/intent mismatches (the change does something the description never claimed, or omits something it promised) as a summary note. A missing or empty description degrades gracefully — the review still runs.

## Requirements

- Node.js `>=24`
- `git` available in the runtime (full history — the review diffs against the merge base)
- A run in one of the two supported contexts, which the tool auto-detects:
  - **GitLab CI** in a merge-request pipeline (`GITLAB_CI`, `CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID`), or
  - **GitHub Actions** on a `pull_request` event (`GITHUB_ACTIONS`, `GITHUB_REPOSITORY`, the PR number)

Detection precedence: an explicit `--platform github|gitlab` (or `CODE_REVIEW_PLATFORM`) always wins; otherwise `GITHUB_ACTIONS=true` selects GitHub and `GITLAB_CI=true` (or a present `CI_PROJECT_ID` / `CI_SERVER_URL`) selects GitLab; failing that, the tool infers the platform from whichever side's identifiers are present.

## Install / Run

Run without installing:

```bash
npx @weareikko/code-review
```

Or install in your project:

```bash
npm i -D @weareikko/code-review
npx code-review --help
```

### Binary entrypoint

This package exposes the `code-review` binary through:

- `bin/code-review.js` (runtime shim)
- `dist/cli.js` (compiled CLI)

## Usage

```bash
code-review [options]
```

Common local dry-run:

```bash
code-review \
  --project 123 \
  --mr 42 \
  --gitlab-url https://gitlab.example.com \
  --gitlab-token "$GITLAB_TOKEN" \
  --model anthropic/claude-sonnet-4-5 \
  --api-key "$ANTHROPIC_API_KEY" \
  --dry-run
```

## GitLab CI example

```yml
review:
  image: node:24
  stage: post
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: '0'
    # A model is required (no default). Provide its provider's key as a masked
    # CI/CD variable, e.g. ANTHROPIC_API_KEY.
    CODE_REVIEW_MODEL: anthropic/claude-sonnet-4-5
  script:
    - npx @weareikko/code-review
  artifacts:
    when: always
    paths:
      - code-review.md
      - review-comments.json
      - review-usage.json
```

## GitHub Actions example

On GitHub the same engine reviews **pull requests** — auto-detected from the Actions environment (`GITHUB_ACTIONS`, `GITHUB_REPOSITORY`, the `pull_request` event); pass `--platform github` to force it. Findings post as one batched PR review with inline comments plus an upserted summary comment.

### Composite action (recommended)

The bundled composite action is the primary path: it checks out the repository, sets up Node, installs the CLI, and runs the review in one step. It needs:

- **Permissions:** `pull-requests: write` (to post the review and summary) and `contents: read` (to check out the code). The default `GITHUB_TOKEN` is enough; the action reads it as `${{ github.token }}` by default.
- **Full git history:** the action checks out the repository by default with `fetch-depth: 0` so the merge-base diff and commit log resolve (tune with `fetch-depth`, or set `checkout: false` and check out yourself first).
- **A model + its key:** pass the model via the `model` input and the provider's key via the `api-key` input (or expose the provider's standard env var, e.g. `ANTHROPIC_API_KEY`, to the step).

```yml
name: code-review
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      # Checkout (full history) is bundled — no separate checkout step needed.
      # Opt out with `checkout: false` if your job already checked out the code.
      - uses: weareikko/code-review@0.8 # moving minor tag — auto patch updates (see Pinning below)
        with:
          model: anthropic/claude-sonnet-4-5
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          # github-token defaults to ${{ github.token }}
          # args: --min-severity warn --dry-run
```

Inputs: `model` (required), `api-key`, `github-token` (default `${{ github.token }}`), `version` (npm dist-tag/version, default `latest`), `node-version` (default `24`), `working-directory`, `args` (extra CLI flags forwarded verbatim), `checkout` (default `true` — bundled repository checkout), and `fetch-depth` (default `0` — full history, required for the merge-base diff).

Because the composite action references your secrets directly (`${{ secrets.ANTHROPIC_API_KEY }}`), it works from **any** repository, including consumers in a different organization from this one.

> **Pinning the ref.** Two moving tags are maintained, each re-pointed to the latest release it covers:
>
> - `@0.8` — **minor series**: newest `0.8.x`, patches only. Because a `0.x` minor bump marks a breaking change, this is the non-breaking channel and the recommended pin while the project is pre-1.0.
> - `@0` — **major series**: newest stable release. **Caveat:** in 0.x a minor bump _is_ a breaking change, so `@0` may advance across breaking releases (`0.8 → 0.9`); it becomes a true semver compatibility boundary only once `1.0` ships.
>
> For a frozen build, pin an exact patch (`@0.8.3`) or a commit SHA (immutable; strongest supply-chain posture); to track the tip, use `@main`. GitHub `uses:` refs do not support wildcards, so `@0.8.x` is not valid — use a moving tag instead.

### Reusable workflow (same org/enterprise)

The bundled reusable workflow lets a caller enable reviews with no `steps:` of its own — it checks out the code, installs the CLI, and runs the review for you:

```yml
name: code-review
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    uses: weareikko/code-review/.github/workflows/code-review.yml@0.8 # moving minor tag — auto patch updates
    secrets: inherit
```

It reads review settings from repo/org **variables** (`CODE_REVIEW_MODEL`, `CODE_REVIEW_DEPTH`, `CODE_REVIEW_THINKING_LEVEL`, `CODE_REVIEW_VERIFY_MODEL`) and provider credentials from **secrets** named with the `CODE_REVIEW_` prefix (e.g. `CODE_REVIEW_ANTHROPIC_API_KEY`), which the CLI's env shim de-prefixes for the provider. Optional `with:` inputs: `model` (overrides the `CODE_REVIEW_MODEL` variable), `version`, `node-version`, `working-directory`, `args`, and `runs-on`.

> **Caveat — `secrets: inherit` is same-organization (or enterprise) only.** Organization secrets are **not** inherited across organizations, so this pattern only works when the caller repository lives in the same org (or enterprise) as `weareikko/code-review`. Cross-organization consumers must use the **composite action** above, which references their own secrets directly. (The reusable workflow relies on `secrets: inherit` and declares no `workflow_call.secrets`, so there is no explicit-secrets path for it.)

### Running the CLI directly

Prefer no action at all? `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, and the PR number are read straight from the Actions environment. Check out the code first (full history) so the merge-base diff resolves:

```yml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0
- uses: actions/setup-node@v5
  with:
    node-version: 24
- run: npx @weareikko/code-review
  env:
    GITHUB_TOKEN: ${{ github.token }}
    CODE_REVIEW_MODEL: anthropic/claude-sonnet-4-5
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Documentation

The README covers getting started. Reference material lives in [`docs/`](https://github.com/weareikko/code-review/tree/main/docs):

- [Configuration](https://github.com/weareikko/code-review/blob/main/docs/configuration.md) — full environment-variable and CLI-flag reference, plus the `CODE_REVIEW_` namespacing convention.
- [Providers](https://github.com/weareikko/code-review/blob/main/docs/providers.md) — Anthropic, OpenRouter, Gemini, Ollama, and OpenAI-compatible endpoints, plus heterogeneous review with a model pool.
- [Skills](https://github.com/weareikko/code-review/blob/main/docs/skills.md) — built-in, external (`npm:`/`file:`/`git:`), Claude plugin marketplaces, and project auto-discovered review skills.
- [Multi-stage review](https://github.com/weareikko/code-review/blob/main/docs/multi-stage-review.md) — the staged Find / Verify / Synthesize pipeline behind `--review-depth`.
- [Observability](https://github.com/weareikko/code-review/blob/main/docs/observability.md) — diagnostics-channel tracing and the opt-in OpenTelemetry bridge (spans, metrics, logs).
- [Output format](https://github.com/weareikko/code-review/blob/main/docs/output-format.md) — inline-comment shape, the upserted summary (a note on GitLab, an issue comment on GitHub), footer, and duplicate prevention.

## Configuration

The CLI auto-resolves most values from the CI environment (GitLab CI variables or the GitHub Actions context) and provider-standard env vars. The two things you must provide are a model and its provider's API key:

```bash
code-review --model anthropic/claude-sonnet-4-5 --api-key "$ANTHROPIC_API_KEY"
```

Equivalently, set `CODE_REVIEW_MODEL` and the provider's key (e.g. `ANTHROPIC_API_KEY`) as CI/CD variables (GitLab) or repository/organization variables and secrets (GitHub). Common knobs include `--min-severity`, `--thinking`, `--posting-mode draft`, `--no-summary`, and `--dry-run`. See the full [environment-variable and flag reference](https://github.com/weareikko/code-review/blob/main/docs/configuration.md).

## Providers

`code-review` uses [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi-ai) for model access. Any registered provider can be selected with `--model provider/modelId` (e.g. `anthropic/claude-sonnet-4-5`, `openrouter/anthropic/claude-3-opus-20240229`, `google/gemini-2.0-flash`, `ollama/qwen2.5-coder:32b`). See [Providers](https://github.com/weareikko/code-review/blob/main/docs/providers.md) for per-provider setup and the model pool.

## Artifacts

- `code-review.md`: raw review text returned by the agent
- `review-comments.json`: generated comment objects including:
  - parsed comment payload
  - computed fingerprints
  - duplicate status
  - final platform-specific posting payload (a GitLab discussion payload, or a GitHub review-comment payload)
- `review-usage.json`: token and cost breakdown for the run (`tokens.{input,output,cacheRead,cacheWrite,total}`, `cost.{input,output,cacheRead,cacheWrite,total}`, `model`)

The CLI also prints a one-line summary at the end of the run:

```
Review usage: 12,345 in / 678 out tokens — $0.0421 (anthropic/claude-sonnet-4-5)
```

Use these files for CI debugging and auditing.

## Troubleshooting

- **`Node.js >=24 is required`**
  - Use `node:24` (or newer) in CI.
- **`Missing required configuration`**
  - Provide required flags or ensure the platform's identifiers/token are available: on GitLab `CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID`, and a GitLab token; on GitHub `GITHUB_REPOSITORY`, the PR number, and `GITHUB_TOKEN`. A model and its API key are required on both.
- **`Could not detect the review platform` / `Ambiguous review platform`**
  - Set `--platform github|gitlab` (or `CODE_REVIEW_PLATFORM`) to force the platform.
- **`--min-severity must be one of: info, warn, critical`**
  - Fix `--min-severity` or `CODE_REVIEW_MIN_SEVERITY`.
- **Git history errors / merge-base failures**
  - Fetch full history: `GIT_DEPTH: 0` on GitLab, `fetch-depth: 0` on `actions/checkout` (the composite action does this by default).
  - Ensure source and target branches are fetchable from `origin`.
- **API 401/403 when posting**
  - GitLab: ensure the token can read MR metadata/discussions and create MR discussions; with `CI_JOB_TOKEN`, check that project settings allow the required API access.
  - GitHub: ensure the token has `pull-requests: write` (the default `GITHUB_TOKEN` with that permission is enough).
- **No comments posted**
  - Check `review-comments.json` for `duplicate: true` or empty parsed comments.
  - Run with `--dry-run` and inspect `code-review.md` formatting (`== Inline Comments ==`).

## Development / release

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Eval tests call the real LLM and require `ANTHROPIC_API_KEY` (or `CODE_REVIEW_API_KEY`) in a local `.env` file:

```bash
npm run test:evals
```

Override the model for cheaper/faster eval runs:

```bash
CODE_REVIEW_EVAL_MODEL=anthropic/claude-haiku-4-5-20251001 npm run test:evals
```

The review agent runs against pinned `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent` versions, so published builds keep a deterministic reviewer runtime.

## Acknowledgements

`code-review` builds on ideas and prior work from several projects:

- **[pi-reviewer](https://github.com/earendil-works/pi-reviewer)** — the original agent-driven code reviewer that `code-review` grew out of. The agent runtime (`@earendil-works/pi-agent-core`), model abstraction (`@earendil-works/pi-ai`), and read-only coding tools (`@earendil-works/pi-coding-agent`) are all pi-reviewer infrastructure.
- **[Warden](https://warden.sentry.dev)** by Sentry — the skills architecture (per-skill instruction blocks, reference files loaded on demand by the agent, project-level discovery) takes direct inspiration from Warden's approach to composable, domain-specific review modules.
- **[agentskills.io](https://agentskills.io)** — the `SKILL.md` frontmatter format and multi-file skill layout (`references/`, `scripts/`, `assets/`) follow the agentskills.io open standard for portable agent skills.
