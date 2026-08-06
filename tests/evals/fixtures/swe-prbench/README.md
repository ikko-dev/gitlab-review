# SWE-PRBench TS/JS pilot subset

`tsjs-subset.jsonl` is a 16-PR TypeScript/JavaScript subset derived from the
**SWE-PRBench** dataset (`eval_split` config), for piloting real-world code-review
evaluation in the languages we actually ship.

- Source: [foundry-ai/swe-prbench](https://huggingface.co/datasets/foundry-ai/swe-prbench) · [FoundryHQ-AI/swe-prbench](https://github.com/FoundryHQ-AI/swe-prbench)
- License: **CC BY 4.0** (attribution: SWE-PRBench authors, Foundry AI)
- Selection: `language ∈ {TypeScript, JavaScript}`, ≥1 gold comment on a code path,
  `diff_patch` < 40k chars, spread across difficulty types. See
  `scratchpad/extract.py` in the working session for the exact filter.

Each line has: `task_id, repo, pr_number, language, pr_type, difficulty,
rvs_score, title, description, base_commit, head_commit, diff_patch`,
plus gold review comments in two forms:

- `gold_comments_all` — every human review comment on the PR (raw).
- `gold_comments_code` — comments on code paths only (lockfiles, changesets,
  docs, snapshots, `.d.ts` dropped).

**Caveat:** gold comments are raw human PR-review threads (questions, replies,
style suggestions, occasional real defects). They are NOT pre-labeled as defects.
The eval applies an LLM triage pass to isolate real defects before scoring recall,
and also reports a gold-independent fabrication rate.

## Running

```bash
# 1. Materialize real checkouts at the reviewed state (gitignored repos/ cache).
#    Blobless clone → checkout base_commit → git apply diff → commit.
node tests/evals/fixtures/swe-prbench/materialize.mjs            # all
node tests/evals/fixtures/swe-prbench/materialize.mjs --limit 6  # subset

# 2. Run the depth×thinking sweep with file access (agent explores the checkout).
#    Only materialized instances run. Gold triage is frozen across cells.
npx vitest run --config vite.eval.config.ts swe-prbench-sweep
```

Knobs via env: `GITLAB_REVIEW_SWEPR_MODEL`, `_DEPTHS`, `_THINKING`, `_TRIALS`,
`_CONCURRENCY`, `_LIMIT`, `_ONLY`, `_FRESH`. Shared logic lives in
`tests/evals/swe-prbench-lib.ts`; outputs in `test-results/swe-prbench-sweep.{json,md}`.
