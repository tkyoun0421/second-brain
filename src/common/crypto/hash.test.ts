import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, hashRequest } from "#app/common/crypto/hash.js";

test("canonical JSON sorts object keys without changing array order", () => {
  assert.equal(canonicalJson({ b: 1, a: { z: 3, y: 2 } }), '{"a":{"y":2,"z":3},"b":1}');
  assert.notEqual(hashRequest({ items: [1, 2] }), hashRequest({ items: [2, 1] }));
  assert.equal(hashRequest({ b: 1, a: 2 }), hashRequest({ a: 2, b: 1 }));
});
