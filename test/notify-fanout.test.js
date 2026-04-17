const test = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server");
const { base44List, base44Ok } = require("./helpers/mocks");

function reset() {
  server.__resetHttpRequest();
  server.__resetFetchURL();
}

test("notifyAllVoters is a no-op when there are no voters", async (t) => {
  t.after(reset);
  let createCalls = 0;
  server.__setHttpRequest(async (options) => {
    if (options.method === "GET") return base44List([]);
    if (options.path.endsWith("/Notification")) createCalls += 1;
    return base44Ok();
  });

  await server.notifyAllVoters("w1", "Title", "oracle_locked", "msg");
  assert.equal(createCalls, 0);
});

test("notifyAllVoters posts one Notification per voter with voter_email", async (t) => {
  t.after(reset);
  const voters = [
    { voter_email: "a@example.com" },
    { voter_email: "b@example.com" },
    { voter_email: "c@example.com" },
  ];
  const notifyBodies = [];
  server.__setHttpRequest(async (options, body) => {
    if (options.method === "GET") return base44List(voters);
    if (options.path.endsWith("/Notification")) {
      notifyBodies.push(JSON.parse(body));
      return base44Ok();
    }
    return base44Ok();
  });

  await server.notifyAllVoters("w1", "Title", "oracle_locked", "msg");
  assert.equal(notifyBodies.length, 3);
  const emails = notifyBodies.map((b) => b.user_email).sort();
  assert.deepEqual(emails, ["a@example.com", "b@example.com", "c@example.com"]);
  for (const body of notifyBodies) {
    assert.equal(body.type, "oracle_locked");
    assert.equal(body.message, "msg");
    assert.equal(body.whisper_id, "w1");
    assert.equal(body.is_read, false);
  }
});

test("notifyAllVoters skips voters missing voter_email", async (t) => {
  t.after(reset);
  const voters = [
    { voter_email: "has@example.com" },
    { voter_email: null },
    {},
    { voter_email: "" },
  ];
  let createCalls = 0;
  server.__setHttpRequest(async (options) => {
    if (options.method === "GET") return base44List(voters);
    if (options.path.endsWith("/Notification")) createCalls += 1;
    return base44Ok();
  });

  await server.notifyAllVoters("w2", "Title", "oracle_revealed", "msg");
  assert.equal(createCalls, 1);
});

test("notifyAllVoters currently sends sequentially (max concurrency = 1)", async (t) => {
  // Pins the current behavior: notifications are sent one at a time.
  // If this test fails because concurrency went up, that's actually an
  // improvement — update the assertion. But don't let it change silently.
  t.after(reset);

  const voters = Array.from({ length: 5 }, (_, i) => ({
    voter_email: `v${i}@example.com`,
  }));
  let inFlight = 0;
  let maxInFlight = 0;

  server.__setHttpRequest(async (options) => {
    if (options.method === "GET") return base44List(voters);
    if (options.path.endsWith("/Notification")) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return base44Ok();
    }
    return base44Ok();
  });

  await server.notifyAllVoters("w3", "T", "oracle_locked", "msg");
  assert.equal(maxInFlight, 1, "expected sequential fan-out");
});

test("notifyAllVoters swallows per-voter Notification failures", async (t) => {
  t.after(reset);

  const voters = [
    { voter_email: "a@example.com" },
    { voter_email: "b@example.com" },
  ];
  let attempts = 0;
  server.__setHttpRequest(async (options) => {
    if (options.method === "GET") return base44List(voters);
    if (options.path.endsWith("/Notification")) {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
      return base44Ok();
    }
    return base44Ok();
  });

  // Should not reject even though the first notification errored.
  await server.notifyAllVoters("w4", "T", "oracle_revealed", "msg");
  assert.equal(attempts, 2, "second voter should still be attempted");
});

test("getVotersForWhisper returns [] on API error (does not throw)", async (t) => {
  t.after(reset);
  server.__setHttpRequest(async () => {
    throw new Error("network down");
  });
  const voters = await server.getVotersForWhisper("w1");
  assert.deepEqual(voters, []);
});
