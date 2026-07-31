import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("./checkpoint-hook.ts", import.meta.url));

function runHook(input: object) {
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify(input),
  });
}

test("checkpoint hook emits a Stop continuation request for a milestone", () => {
  const result = runHook({
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "배포 검증을 완료했습니다.",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /"decision":"block"/);
  assert.match(result.stdout, /brain_capture_auto_memory/);
});

test("checkpoint hook stays silent for malformed or non-qualifying events", () => {
  const malformed = runHook({ not_a_hook_event: true });
  const casual = runHook({
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "안녕하세요.",
  });

  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, "");
  assert.equal(casual.status, 0);
  assert.equal(casual.stdout, "");
});
