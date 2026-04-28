const test = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server");
const { requestJSON } = require("./helpers/http-client");

function withEnv(vars, fn) {
  const original = {};
  for (const k of Object.keys(vars)) {
    original[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(vars)) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });
}

test("/healthz returns 200 with uptime", async () => {
  const res = await requestJSON(server.app, "GET", "/healthz");
  assert.equal(res.status, 200);
  assert.equal(res.data.status, "ok");
  assert.equal(typeof res.data.uptime_seconds, "number");
});

test("/healthz stays 200 even if env vars are missing", async () => {
  await withEnv({ BASE44_API_KEY: undefined, amphoracle_railway: undefined }, async () => {
    const res = await requestJSON(server.app, "GET", "/healthz");
    assert.equal(res.status, 200, "liveness should never fail on missing config");
  });
});

test("/readyz: 503 when recovery has not completed", async () => {
  const original = server.readinessState.recoveryComplete;
  server.readinessState.recoveryComplete = false;
  try {
    await withEnv(
      { BASE44_API_KEY: "x", amphoracle_railway: "y" },
      async () => {
        const res = await requestJSON(server.app, "GET", "/readyz");
        assert.equal(res.status, 503);
        assert.ok(res.data.reasons.includes("boot_recovery_pending"));
      },
    );
  } finally {
    server.readinessState.recoveryComplete = original;
  }
});

test("/readyz: 503 when BASE44_API_KEY is missing", async () => {
  server.readinessState.recoveryComplete = true;
  await withEnv({ BASE44_API_KEY: undefined, amphoracle_railway: "y" }, async () => {
    const res = await requestJSON(server.app, "GET", "/readyz");
    assert.equal(res.status, 503);
    assert.ok(res.data.reasons.includes("BASE44_API_KEY_missing"));
  });
});

test("/readyz: 503 when ANTHROPIC key (amphoracle_railway) is missing", async () => {
  server.readinessState.recoveryComplete = true;
  await withEnv({ BASE44_API_KEY: "x", amphoracle_railway: undefined }, async () => {
    const res = await requestJSON(server.app, "GET", "/readyz");
    assert.equal(res.status, 503);
    assert.ok(res.data.reasons.includes("ANTHROPIC_KEY_missing"));
  });
});

test("/readyz: 200 when recovery complete and required env vars are set", async () => {
  server.readinessState.recoveryComplete = true;
  await withEnv({ BASE44_API_KEY: "x", amphoracle_railway: "y" }, async () => {
    const res = await requestJSON(server.app, "GET", "/readyz");
    assert.equal(res.status, 200);
    assert.equal(res.data.status, "ready");
  });
});
