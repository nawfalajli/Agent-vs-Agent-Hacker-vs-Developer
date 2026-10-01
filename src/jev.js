// Jev (TypeSafe AI System One) as the optional referee for a security finding: it returns
// calibrated typed answers (not text), so an uncertain finding goes to a human instead of
// being guessed at. https://docs.typesafe.ai/api  Without a key, this module is not used.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate({ apiKey, apiUrl, model }, body, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ...body }),
    });
    if ((res.status === 429 || res.status === 529) && attempt < retries) { await sleep(1000 * 2 ** attempt); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(`Jev -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
}

/** Ask Jev whether a Hacker finding is real, in scope, and not a duplicate, plus a severity call. */
export async function jevReferee(jev, { repo, finding, known = [] }) {
  const state = {
    repository: repo.name,
    finding: {
      title: finding.title, cwe: finding.cwe, severity: finding.severity,
      location: finding.location, summary: finding.summary, proof_idea: finding.proofIdea,
    },
    already_handled: known.map((k) => ({ cwe: k.cwe, location: k.location, title: k.title })),
  };
  const questions = {
    real: { type: 'noul', instructions: 'Is `finding` a genuine, exploitable security weakness in this code, not a false positive or theoretical note?' },
    in_scope: { type: 'noul', instructions: 'Is `finding` a code weakness inside `repository` (not a dependency advisory, infra, or out-of-repo issue)?' },
    severity: {
      type: 'choice',
      instructions: 'Rate the real-world severity of `finding`.',
      criteria: { low: 'Minor, limited impact', medium: 'Meaningful impact, some constraints', high: 'Serious, easily reachable', critical: 'Severe, trivially exploitable' },
    },
    duplicate: { type: 'noul', instructions: 'Is `finding` the same weakness as one already in `already_handled`?' },
  };
  const { answers, model } = await evaluate(jev, { state, questions });
  return {
    model,
    real: answers.real?.noul ?? 1,
    inScope: answers.in_scope?.noul ?? 1,
    severity: answers.severity?.choice ?? finding.severity,
    severityConfidence: answers.severity?.confidence ?? 1,
    duplicate: answers.duplicate?.noul ?? 0,
    confidence: Math.min(answers.real?.confidence ?? 1, answers.in_scope?.confidence ?? 1),
  };
}

/**
 * Turn a Jev verdict into an action for the finding. Below `minConfidence` it goes to a human;
 * a finding Jev judges unreal, out of scope, or a duplicate is dropped.
 */
export function applyReferee(finding, verdict, minConfidence) {
  const summary = `Jev real=${verdict.real.toFixed(2)} scope=${verdict.inScope.toFixed(2)} sev=${verdict.severity} dup=${verdict.duplicate.toFixed(2)} (conf ${verdict.confidence.toFixed(2)})`;
  if (verdict.confidence < minConfidence) return { action: 'needs-triage', jev: summary, finding };
  if (verdict.duplicate >= 0.5) return { action: 'dismissed', jev: `${summary}; duplicate`, finding };
  if (verdict.real < 0.5 || verdict.inScope < 0.5) return { action: 'dismissed', jev: `${summary}; not a real in-scope finding`, finding };
  const severity = verdict.severityConfidence >= minConfidence ? verdict.severity : finding.severity;
  return { action: 'accept', jev: summary, finding: { ...finding, severity } };
}
