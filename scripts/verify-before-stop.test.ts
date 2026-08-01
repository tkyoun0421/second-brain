import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hookPath = fileURLToPath(new URL("../.codex/hooks/verify-before-stop.mjs", import.meta.url));
const hookConfigPath = fileURLToPath(new URL("../.codex/hooks.json", import.meta.url));

test("project Codex configuration runs production verification at Stop", () => {
  const config = JSON.parse(readFileSync(hookConfigPath, "utf8")) as {
    hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string; commandWindows?: string }> }> };
  };
  const handler = config.hooks?.Stop?.[0]?.hooks?.[0];

  assert.match(handler?.command ?? "", /verify-before-stop\.mjs/);
  assert.match(handler?.commandWindows ?? "", /verify-before-stop\.mjs/);
});

test("production verification Stop hook does not recursively start another verification pass", () => {
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "{}\n");
});
