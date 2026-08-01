import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "#app/errors.js";
import { rejectSensitiveData } from "#app/sensitive.js";

test("sensitive scanner rejects nested GitHub tokens without returning the token", () => {
  assert.throws(
    () => rejectSensitiveData({ sources: [{ excerpt: "token ghp_abcdefghijklmnopqrstuvwxyz1234567890" }] }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "SENSITIVE_DATA_DETECTED");
      assert.deepEqual(error.details, [{
        path: "/sources/0/excerpt",
        reason: "access_token",
        rule_id: "credential.github_token.v1",
      }]);
      assert.doesNotMatch(error.message, /ghp_/);
      return true;
    },
  );
});
