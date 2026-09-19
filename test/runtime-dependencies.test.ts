import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

test("Defender and Transformers resolve the same native ONNX runtime", () => {
  const require = createRequire(import.meta.url);
  const defenderRequire = createRequire(require.resolve("@stackone/defender"));
  const transformersRequire = createRequire(
    require.resolve("@huggingface/transformers"),
  );

  // Different runtime versions can collide in Linux's shared-library loader,
  // even when the ML integration test passes on macOS.
  assert.equal(
    defenderRequire.resolve("onnxruntime-node"),
    transformersRequire.resolve("onnxruntime-node"),
    "Keep Defender's ONNX peer aligned with Transformers' native runtime",
  );
});
