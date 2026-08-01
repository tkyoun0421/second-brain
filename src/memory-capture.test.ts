import assert from "node:assert/strict";
import test from "node:test";

import {
  assessCaptureCandidate,
  automaticCaptureKey,
  toCapturedMemory,
  type AutomaticCaptureCandidate,
} from "#app/memory-capture.js";

const candidate = (
  overrides: Partial<AutomaticCaptureCandidate> = {},
): AutomaticCaptureCandidate => ({
  kind: "decision",
  statement: "Use the production health endpoint for deploy checks.",
  rationale: "It prevents a successful build from masking an unavailable API.",
  scope: { type: "repository", id: "42" },
  tags: ["deployment"],
  trigger: "agent_checkpoint",
  source: {
    source_type: "agent_run",
    source_id: "100",
    source_uri: null,
    source_excerpt: "Healthcheck passed after deployment.",
  },
  occurred_at: "2026-07-31T00:00:00.000Z",
  signals: {
    reusability: 3,
    impact: 3,
    scope: 2,
    evidence: 2,
    noise_penalty: 0,
  },
  decision: {
    alternatives: ["Skip the health check"],
  },
  ...overrides,
});

test("low-value transient failures are discarded instead of becoming memories", () => {
  const assessment = assessCaptureCandidate(candidate({
    kind: "failure",
    statement: "A single local command timed out once.",
    rationale: null,
    trigger: "error_resolution",
    signals: { reusability: 0, impact: 1, scope: 0, evidence: 0, noise_penalty: 1 },
    failure: {
      resolution_status: "observed",
      symptom: "The command timed out once.",
      environment: null,
      attempts: [],
      cause_or_hypothesis: null,
      resolution: null,
      verification: [],
    },
  }));

  assert.equal(assessment.outcome, "discarded");
  assert.equal(assessment.importance_score, 0);
  assert.deepEqual(assessment.reasons, ["low_reuse", "low_impact", "narrow_scope", "limited_evidence", "noise_penalty"]);
});

test("reusable, evidenced candidates are stored in the inbox as proposed", () => {
  const assessment = assessCaptureCandidate(candidate());
  const memory = toCapturedMemory(candidate(), assessment);

  assert.equal(assessment.outcome, "stored");
  assert.equal(assessment.importance_score, 10);
  assert.deepEqual(assessment.reasons, ["reusable", "high_impact", "durable_scope", "evidenced"]);
  assert.equal(memory.status, "proposed");
  assert.equal(memory.confidence, 0.9);
  assert.equal(memory.capture.importance_score, 10);
  assert.equal(memory.capture.trigger, "agent_checkpoint");
});

test("automatic capture keys are stable across observation time but isolate scope and content", () => {
  const original = candidate();
  const observedAgain = candidate({ occurred_at: "2026-07-31T02:00:00.000Z" });
  const anotherScope = candidate({ scope: { type: "repository", id: "43" } });
  const anotherStatement = candidate({ statement: "Use a different production health endpoint." });

  assert.equal(automaticCaptureKey(original), automaticCaptureKey(observedAgain));
  assert.notEqual(automaticCaptureKey(original), automaticCaptureKey(anotherScope));
  assert.notEqual(automaticCaptureKey(original), automaticCaptureKey(anotherStatement));
});

test("importance never upgrades captured content to confirmed or verified", () => {
  const assessment = assessCaptureCandidate(candidate());
  const memory = toCapturedMemory(candidate(), assessment);

  assert.equal(memory.status, "proposed");
  assert.equal(memory.confirmation.origin, "agent_inference");
});
