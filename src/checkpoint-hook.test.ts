import assert from "node:assert/strict";
import test from "node:test";

import { createStopCheckpointResponse, shouldRequestCheckpoint } from "#app/checkpoint-hook.js";

test("requests one checkpoint before a completed implementation response is finalized", () => {
  const response = createStopCheckpointResponse({
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "구현과 운영 검증을 완료했습니다.",
  });

  assert.deepEqual(response, {
    decision: "block",
    reason: "Memory checkpoint: before finalizing, inspect this turn for an important decision, user choice, or resolved error. If there is a reusable candidate with total importance 4 or higher, call brain_capture_auto_memory once. Write the candidate statement, rationale, and failure details in Korean; retain only technical identifiers and API names verbatim. Do not store secrets, credentials, or one-off noise. If no qualifying candidate exists, finalize without calling the tool.",
  });
});

test("does not start a recursive checkpoint after the checkpoint continuation", () => {
  const response = createStopCheckpointResponse({
    hook_event_name: "Stop",
    stop_hook_active: true,
    last_assistant_message: "구현과 운영 검증을 완료했습니다.",
  });

  assert.equal(response, null);
});

test("does not add a checkpoint round trip for casual replies", () => {
  assert.equal(shouldRequestCheckpoint("안녕하세요. 무엇을 도와드릴까요?"), false);
  assert.equal(
    createStopCheckpointResponse({
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "안녕하세요. 무엇을 도와드릴까요?",
    }),
    null,
  );
});

test("recognizes user choices and resolved errors as checkpoint-worthy moments", () => {
  assert.equal(shouldRequestCheckpoint("Railway로 배포하는 것으로 선택했습니다."), true);
  assert.equal(shouldRequestCheckpoint("인증 오류의 원인을 찾아 해결했습니다."), true);
});
