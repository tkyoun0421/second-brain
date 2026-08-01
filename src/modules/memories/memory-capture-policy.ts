import { canonicalJson, sha256 } from "#app/common/crypto/hash.js";

export const importancePolicyVersion = "importance-v1";
export const minimumStoredImportance = 4;

export type CaptureScope = {
  type: "global" | "organization" | "repository" | "project" | "path" | "task";
  id: string;
};

export type CaptureSource = {
  source_type: "github_issue" | "github_comment" | "user_message" | "test_result" | "document" | "agent_run" | "policy_event";
  source_id: string;
  source_uri: string | null;
  source_excerpt: string | null;
};

export type CaptureSignals = {
  reusability: 0 | 1 | 2 | 3;
  impact: 0 | 1 | 2 | 3;
  scope: 0 | 1 | 2;
  evidence: 0 | 1 | 2;
  noise_penalty: 0 | 1 | 2 | 3;
};

type FailureDetail = {
  resolution_status: "observed" | "investigating" | "hypothesis" | "resolved" | "verified" | "recurring";
  symptom: string;
  environment: string | null;
  attempts: string[];
  cause_or_hypothesis: string | null;
  resolution: string | null;
  verification: string[];
};

export type AutomaticCaptureCandidate = {
  kind: "decision" | "failure";
  statement: string;
  rationale: string | null;
  scope: CaptureScope;
  tags: string[];
  trigger: "agent_checkpoint" | "user_choice" | "error_resolution";
  source: CaptureSource;
  occurred_at: string;
  signals: CaptureSignals;
  decision?: { alternatives: string[] };
  failure?: FailureDetail;
};

export type CaptureAssessment = {
  outcome: "discarded" | "stored";
  importance_score: number;
  reasons: string[];
  policy_version: typeof importancePolicyVersion;
};

export type CapturedMemory = {
  kind: AutomaticCaptureCandidate["kind"];
  statement: string;
  rationale: string | null;
  scope: CaptureScope;
  status: "proposed";
  confidence: number;
  sources: CaptureSource[];
  confirmation: {
    origin: "agent_inference";
    source: { type: string; id: string };
    confirmed_at: string;
  };
  valid_from: string;
  valid_until: null;
  tags: string[];
  decision?: { alternatives: string[]; decided_at: string };
  failure?: FailureDetail;
  capture: {
    importance_score: number;
    importance_reasons: string[];
    trigger: AutomaticCaptureCandidate["trigger"];
    policy_version: typeof importancePolicyVersion;
    dedupe_key: string;
  };
};

const boundedScore = (value: number) => Math.max(0, Math.min(10, value));

const reasonFor = (value: number, highAt: number, high: string, low: string) => value >= highAt ? high : low;

export const assessCaptureCandidate = (candidate: AutomaticCaptureCandidate): CaptureAssessment => {
  const { reusability, impact, scope, evidence, noise_penalty: noisePenalty } = candidate.signals;
  const importanceScore = boundedScore(reusability + impact + scope + evidence - noisePenalty);
  const reasons = [
    reasonFor(reusability, 2, "reusable", "low_reuse"),
    reasonFor(impact, 2, "high_impact", "low_impact"),
    reasonFor(scope, 1, "durable_scope", "narrow_scope"),
    reasonFor(evidence, 1, "evidenced", "limited_evidence"),
    ...(noisePenalty > 0 ? ["noise_penalty"] : []),
  ];
  return {
    outcome: importanceScore >= minimumStoredImportance ? "stored" : "discarded",
    importance_score: importanceScore,
    reasons,
    policy_version: importancePolicyVersion,
  };
};

const normalizedStatement = (statement: string) => statement.trim().replace(/\s+/g, " ");

export const automaticCaptureKey = (candidate: AutomaticCaptureCandidate): string =>
  `auto:${importancePolicyVersion}:${sha256(canonicalJson({
    kind: candidate.kind,
    statement: normalizedStatement(candidate.statement),
    scope: candidate.scope,
  }))}`;

const confidenceFor = (evidence: CaptureSignals["evidence"]): number => {
  if (evidence === 2) return 0.9;
  if (evidence === 1) return 0.65;
  return 0.4;
};

export const toCapturedMemory = (
  candidate: AutomaticCaptureCandidate,
  assessment = assessCaptureCandidate(candidate),
): CapturedMemory => {
  const kindDetail = candidate.kind === "decision"
    ? { decision: { alternatives: candidate.decision?.alternatives ?? [], decided_at: candidate.occurred_at } }
    : candidate.failure ? { failure: candidate.failure } : {};
  return {
    kind: candidate.kind,
    statement: candidate.statement,
    rationale: candidate.rationale,
    scope: candidate.scope,
    status: "proposed",
    confidence: confidenceFor(candidate.signals.evidence),
    sources: [candidate.source],
    confirmation: {
      origin: "agent_inference",
      source: { type: candidate.source.source_type, id: candidate.source.source_id },
      confirmed_at: candidate.occurred_at,
    },
    valid_from: candidate.occurred_at,
    valid_until: null,
    tags: candidate.tags,
    ...kindDetail,
    capture: {
      importance_score: assessment.importance_score,
      importance_reasons: assessment.reasons,
      trigger: candidate.trigger,
      policy_version: assessment.policy_version,
      dedupe_key: automaticCaptureKey(candidate),
    },
  };
};
