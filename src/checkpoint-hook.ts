export type StopHookInput = {
  hook_event_name?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
};

export type StopHookResponse = {
  decision: "block";
  reason: string;
};

const checkpointSignals = [
  /\b(completed|implemented|fixed|resolved|decision|selected|deployed|validated|migration|committed|pushed|error|failure)\b/i,
  /(완료|구현|수정|해결|결정|선택|확정|배포|검증|마이그레이션|커밋|푸시|오류|에러|실패|원인)/,
];

export const checkpointReason =
  "Memory checkpoint: before finalizing, inspect this turn for an important decision, user choice, or resolved error. If there is a reusable candidate with total importance 4 or higher, call brain_capture_auto_memory once. Write the candidate statement, rationale, and failure details in Korean; retain only technical identifiers and API names verbatim. Do not store secrets, credentials, or one-off noise. If no qualifying candidate exists, finalize without calling the tool.";

export function shouldRequestCheckpoint(lastAssistantMessage: string | null | undefined): boolean {
  if (!lastAssistantMessage?.trim()) {
    return false;
  }

  return checkpointSignals.some((signal) => signal.test(lastAssistantMessage));
}

export function createStopCheckpointResponse(input: StopHookInput): StopHookResponse | null {
  if (input.hook_event_name !== "Stop" || input.stop_hook_active) {
    return null;
  }

  if (!shouldRequestCheckpoint(input.last_assistant_message)) {
    return null;
  }

  return {
    decision: "block",
    reason: checkpointReason,
  };
}
