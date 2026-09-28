/**
 * Regression matrix: canonical-surface/estimator-config.ts
 *
 * isTaskStateEstimatorConfigured — partitioned by which of {baseUrl, apiKey, model} are set
 *   I1 all three set → true
 *   I2 any one missing (3 cases) → false
 *   I3 empty strings count as missing
 * createConfiguredTaskStateEstimator
 *   X1 enabled=false (even if complete)   → undefined
 *   X2 enabled unset/true, incomplete      → undefined
 *   X3 enabled unset, complete             → estimator with estimate()
 *   X4 enabled=true, complete              → estimator with estimate()
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createConfiguredTaskStateEstimator, isTaskStateEstimatorConfigured } from "../src/index.js";

const complete = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" };

describe("isTaskStateEstimatorConfigured", () => {
  it("I1 all of baseUrl, apiKey and model set", () => {
    assert.equal(isTaskStateEstimatorConfigured(complete), true);
  });
  it("I2 any one field missing", () => {
    for (const key of ["baseUrl", "apiKey", "model"] as const) {
      const cfg: Record<string, string> = { ...complete };
      delete cfg[key];
      assert.equal(isTaskStateEstimatorConfigured(cfg), false, key);
    }
  });
  it("I3 empty strings count as missing", () => {
    assert.equal(isTaskStateEstimatorConfigured({ ...complete, model: "" }), false);
  });
});

describe("createConfiguredTaskStateEstimator", () => {
  it("X1 explicitly disabled returns undefined even when complete", () => {
    assert.equal(createConfiguredTaskStateEstimator({ ...complete, enabled: false }), undefined);
  });
  it("X2 incomplete returns undefined", () => {
    assert.equal(createConfiguredTaskStateEstimator({ baseUrl: complete.baseUrl, apiKey: "k" }), undefined);
    assert.equal(createConfiguredTaskStateEstimator({ enabled: true, apiKey: "k", model: "m" }), undefined);
  });
  it("X3 complete with enabled unset returns an estimator", () => {
    assert.equal(typeof createConfiguredTaskStateEstimator(complete)?.estimate, "function");
  });
  it("X4 complete and enabled returns an estimator", () => {
    assert.equal(typeof createConfiguredTaskStateEstimator({ ...complete, enabled: true })?.estimate, "function");
  });
});
