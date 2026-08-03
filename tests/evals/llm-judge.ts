import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai';
import {
  completeSimple,
  getEnvApiKey,
  registerBuiltInApiProviders,
} from '@earendil-works/pi-ai/compat';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import { createJudge } from 'vitest-evals';
import type { Judge, JudgeContext } from 'vitest-evals';

// The judge routes through the same provider stack as the reviewer. Evals must
// NOT make direct OpenAI/Anthropic calls — everything goes through the
// configured provider (in this project's CI, the Cloudflare AI Gateway), so the
// judge model is a `provider/modelId` string resolved via pi-ai, not a raw
// Anthropic endpoint.
const DEFAULT_JUDGE_MODEL = 'cloudflare-ai-gateway/claude-haiku-4-5';

type LlmJudgeVerdict = {
  score: 0 | 1;
  rationale: string;
};

let providersRegistered = false;
function ensureProviders(): void {
  if (providersRegistered) return;
  registerBuiltInApiProviders();
  providersRegistered = true;
}

function getModelId(): string {
  return process.env.CODE_REVIEW_EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
}

/** Split a `provider/modelId` string on the first slash. */
function splitModel(spec: string): { provider: string; modelId: string } {
  const slash = spec.indexOf('/');
  if (slash === -1) return { provider: '', modelId: spec };
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

async function callJudge(systemPrompt: string, userPrompt: string): Promise<LlmJudgeVerdict> {
  ensureProviders();
  const { provider, modelId } = splitModel(getModelId());
  if (!provider) {
    throw new Error(
      `Judge model "${getModelId()}" must be a provider/modelId string (e.g. cloudflare-ai-gateway/claude-3-5-haiku)`,
    );
  }
  const apiKey = getEnvApiKey(provider) ?? '';
  if (!apiKey) {
    throw new Error(
      `LLM judge requires the ${provider} provider key in env (e.g. CLOUDFLARE_API_KEY for cloudflare-ai-gateway)`,
    );
  }
  // getBuiltinModel is statically typed against the MODELS table; the judge
  // model is a runtime string, so resolve through a widened signature.
  const resolve = getBuiltinModel as (p: KnownProvider, m: string) => Model<Api>;
  const model = resolve(provider as KnownProvider, modelId);
  const result = await completeSimple(
    model,
    {
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt, timestamp: Date.now() }],
    },
    { apiKey, maxTokens: 512 },
  );
  if (result.stopReason === 'error' || result.stopReason === 'aborted') {
    throw new Error(`Judge model call failed: ${result.errorMessage ?? result.stopReason}`);
  }
  const text = result.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
    .trim();
  return parseVerdict(text);
}

function parseVerdict(text: string): LlmJudgeVerdict {
  // The judge is instructed to return a single JSON object. We strip code
  // fences and tolerate stray prose around the JSON.
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidate = fenced?.[1] ?? text;
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  if (!objMatch) {
    return { score: 0, rationale: `Judge returned non-JSON: ${text.slice(0, 200)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return { score: 0, rationale: `Judge returned invalid JSON: ${objMatch[0].slice(0, 200)}` };
  }
  if (!parsed || typeof parsed !== 'object' || !('score' in parsed) || !('rationale' in parsed)) {
    return {
      score: 0,
      rationale: `Judge JSON missing required fields: ${JSON.stringify(parsed).slice(0, 200)}`,
    };
  }
  const rawScore = (parsed as { score: unknown }).score;
  const score: 0 | 1 = rawScore === 1 || rawScore === '1' || rawScore === true ? 1 : 0;
  const rationale = String((parsed as { rationale: unknown }).rationale ?? '').slice(0, 600);
  return { score, rationale };
}

export type ReviewSummary = {
  summary: string;
  comments: Array<{
    file: string;
    line: number;
    severity: string;
    body: string;
  }>;
};

function renderReview(review: ReviewSummary): string {
  const commentLines = review.comments.map(
    (c, i) => `${i + 1}. [${c.severity.toUpperCase()}] ${c.file}:${c.line}\n${c.body}`,
  );
  return [
    '<summary>',
    review.summary || '(empty)',
    '</summary>',
    '',
    '<inline_comments>',
    commentLines.length > 0 ? commentLines.join('\n\n') : '(no inline comments)',
    '</inline_comments>',
  ].join('\n');
}

const JUDGE_SYSTEM_PROMPT = [
  'You are an evaluator of automated code reviews. Apply the rubric strictly:',
  'do not award credit for tangential mentions, vague concerns, or unrelated findings.',
  'Return a single JSON object with this exact shape, and nothing else:',
  '',
  '{"score": 0 | 1, "rationale": "<one short sentence>"}',
  '',
  'score=1 ONLY when the review clearly satisfies the rubric.',
  'score=0 when the review misses, is ambiguous about, or only tangentially touches the target.',
].join('\n');

/**
 * Build a rubric-driven LLM judge. The rubric is a short directive — one or
 * two sentences describing what counts as a passing review. The judge sees the
 * full summary and all inline comments.
 */
export function createLlmJudge<I, O extends ReviewSummary>(
  name: string,
  rubric: string,
): Judge<JudgeContext<I, O, Record<string, unknown>>> {
  return createJudge({
    name,
    assess: async ({ output }: JudgeContext<I, O, Record<string, unknown>>) => {
      const review = renderReview(output);
      const userPrompt = [
        'Evaluate the automated code review below against the rubric.',
        '',
        '<rubric>',
        rubric,
        '</rubric>',
        '',
        '<review>',
        review,
        '</review>',
        '',
        'Return the JSON verdict now.',
      ].join('\n');

      try {
        const verdict = await callJudge(JUDGE_SYSTEM_PROMPT, userPrompt);
        return {
          score: verdict.score,
          metadata: {
            rationale: verdict.rationale,
            judgeModel: getModelId(),
          },
        };
      } catch (err) {
        return {
          score: 0,
          metadata: {
            rationale: `LLM judge error: ${(err as Error).message}`,
            judgeModel: getModelId(),
          },
        };
      }
    },
  });
}
