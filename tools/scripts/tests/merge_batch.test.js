const assert = require("assert");
const path = require("path");

const mergeBatch = require(path.join(__dirname, "..", "merge_batch.cjs"));

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const BLOB_SHA = "3".repeat(40);
const ZERO_SHA = "0".repeat(40);

function makeCheckRun(name, status, conclusion, startedAt, id) {
  return {
    name,
    status,
    conclusion,
    started_at: startedAt,
    completed_at: startedAt,
    created_at: startedAt,
    id,
  };
}

{
  const parsed = mergeBatch.parsePrList("450, 449  446");
  assert.deepStrictEqual(parsed, [450, 449, 446]);
}

{
  const parsed = mergeBatch.parseArgs([
    "--prs",
    "450",
    "--reviewed-head",
    HEAD_SHA,
    "--reviewed-head",
    BASE_SHA,
    "--dry-run",
  ]);
  assert.deepStrictEqual(parsed.reviewedHeads, [HEAD_SHA, BASE_SHA]);
  assert.strictEqual(parsed.dryRun, true);
  assert.throws(
    () => mergeBatch.parseArgs(["--reviewed-head", HEAD_SHA.slice(0, 12)]),
    /exact 40-character lowercase commit SHA/,
  );
}

{
  const summary = mergeBatch.extractSummaryBlock(`Summary line 1\nSummary line 2\n\n## Change Classification\n- [ ] Skill PR`);
  assert.strictEqual(summary, "Summary line 1\nSummary line 2");
}

{
  const template = `# Pull Request Description\n\nIntro\n\n## Change Classification\n- [ ] Skill PR\n\n## Quality Bar Checklist ✅\n- [ ] Standards`;
  const body = mergeBatch.normalizePrBody(
    `Short summary\n\n## Change Classification\n- [ ] Old item`,
    template,
  );

  assert.ok(body.startsWith("Short summary"));
  assert.ok(body.includes("## Change Classification"));
  assert.ok(body.includes("## Quality Bar Checklist ✅"));
  assert.ok(!body.includes("Old item"));
}

{
  const aliases = mergeBatch.getRequiredCheckAliases({ hasSkillChanges: true });
  assert.ok(aliases.some((entry) => !Array.isArray(entry) && entry.aliases.includes("review")));
  assert.ok(aliases.some((entry) => Array.isArray(entry) && entry.includes("pr-policy")));
  assert.ok(aliases.some((entry) => Array.isArray(entry) && entry.includes("pr-evidence")));
}

{
  const runs = [
    makeCheckRun("pr-policy", "completed", "failure", "2026-04-01T10:00:00Z", 1),
    makeCheckRun("pr-policy", "completed", "success", "2026-04-01T10:10:00Z", 2),
    makeCheckRun("source-validation", "in_progress", null, "2026-04-01T10:11:00Z", 3),
    makeCheckRun("review", "completed", "success", "2026-04-01T10:12:00Z", 4),
  ];
  const summaries = mergeBatch.summarizeRequiredCheckRuns(runs, [
    ["pr-policy"],
    ["source-validation"],
    ["review", "Skill Review & Optimize"],
  ]);

  assert.deepStrictEqual(
    summaries.map((entry) => entry.state),
    ["success", "pending", "success"],
  );

  const latest = mergeBatch.selectLatestCheckRuns(runs);
  assert.strictEqual(latest.get("pr-policy").conclusion, "success");

  const skippedGate = makeCheckRun("pr-evidence", "completed", "skipped", "2026-04-01T10:13:00Z", 5);
  assert.deepStrictEqual(
    mergeBatch.summarizeRequiredCheckRuns([skippedGate], [["pr-evidence"]]).map((entry) => entry.state),
    ["failed"],
    "a skipped deterministic gate must never pass",
  );
}

{
  const skippedReview = makeCheckRun("Skill Review / review", "completed", "skipped", "2026-04-01T10:00:00Z", 10);
  const manualReview = makeCheckRun("Skill Review / manual-review-required", "completed", "success", "2026-04-01T10:01:00Z", 11);
  const withoutAttestation = mergeBatch.getRequiredCheckAliases(
    { hasSkillChanges: true },
    { allowManualReview: false },
  ).at(-1);
  const withAttestation = mergeBatch.getRequiredCheckAliases(
    { hasSkillChanges: true },
    { allowManualReview: true },
  ).at(-1);

  assert.deepStrictEqual(
    mergeBatch.summarizeRequiredCheckRuns([skippedReview], [withoutAttestation]).map((entry) => entry.state),
    ["failed"],
    "a skipped semantic review must never pass",
  );
  assert.deepStrictEqual(
    mergeBatch.summarizeRequiredCheckRuns([skippedReview, manualReview], [withoutAttestation]).map((entry) => entry.state),
    ["failed"],
    "manual review must not count without an exact-head attestation",
  );
  assert.deepStrictEqual(
    mergeBatch.summarizeRequiredCheckRuns([skippedReview, manualReview], [withAttestation]).map((entry) => entry.state),
    ["success"],
    "manual review may satisfy the check only after exact-head attestation",
  );

  const failedReview = makeCheckRun("Skill Review / review", "completed", "failure", "2026-04-01T10:02:00Z", 12);
  assert.deepStrictEqual(
    mergeBatch.summarizeRequiredCheckRuns([failedReview, manualReview], [withAttestation]).map((entry) => entry.state),
    ["failed"],
    "manual attestation must not override a real failed semantic review",
  );
  const skippedManual = makeCheckRun("Skill Review / manual-review-required", "completed", "skipped", "2026-04-01T10:03:00Z", 13);
  assert.deepStrictEqual(
    mergeBatch.summarizeRequiredCheckRuns([skippedReview, skippedManual], [withAttestation]).map((entry) => entry.state),
    ["missing"],
    "a skipped manual-review job must not pass",
  );
}

{
  assert.strictEqual(mergeBatch.isRetryableMergeError(new Error("Base branch was modified")), true);
  assert.strictEqual(mergeBatch.isRetryableMergeError(new Error("Something else")), false);
}

{
  const literalArg = "safe&echo injected";
  const stdout = mergeBatch.runCommand(
    process.execPath,
    ["-e", "process.stdout.write(process.argv[1])", literalArg],
    path.join(__dirname, "..", "..", ".."),
    { capture: true },
  );
  assert.strictEqual(stdout, literalArg);
}


{
  const raw = Buffer.from(
    `:000000 100644 ${ZERO_SHA} ${BLOB_SHA} A\0skills/example/SKILL.md\0` +
    `:100644 100644 ${BLOB_SHA} ${HEAD_SHA} R100\0skills/example/references/old.md\0skills/example/references/new.md\0`,
    "utf8",
  );
  const records = mergeBatch.parseRawDiff(raw);
  assert.strictEqual(records.length, 2);
  assert.deepStrictEqual(records[0], {
    status: "A",
    old_path: null,
    new_path: "skills/example/SKILL.md",
    old_mode: "000000",
    new_mode: "100644",
    old_oid: ZERO_SHA,
    new_oid: BLOB_SHA,
    similarity: null,
  });
  assert.strictEqual(records[1].status, "R");
  assert.strictEqual(records[1].old_path, "skills/example/references/old.md");
  assert.strictEqual(records[1].new_path, "skills/example/references/new.md");
  assert.strictEqual(records[1].similarity, 100);
  assert.throws(() => mergeBatch.parseRawDiff(raw.subarray(0, raw.length - 1)), /final NUL/);
  assert.throws(() => mergeBatch.parseRawDiff(Buffer.alloc(0)), /empty/);
  assert.deepStrictEqual(mergeBatch.parseRawDiff(Buffer.alloc(0), { allowEmpty: true }), []);

  const mixedWidth = Buffer.from(
    `:100644 100644 ${BLOB_SHA} ${"4".repeat(64)} M\0skills/example/SKILL.md\0`,
    "utf8",
  );
  assert.throws(() => mergeBatch.parseRawDiff(mixedWidth), /Malformed raw Git diff header/);

  const invalidUtf8 = Buffer.concat([
    Buffer.from(`:000000 100644 ${ZERO_SHA} ${BLOB_SHA} A\0skills/example/references/`, "ascii"),
    Buffer.from([0xff, 0]),
  ]);
  assert.throws(() => mergeBatch.parseRawDiff(invalidUtf8), /canonical UTF-8/);
}

function workflowFixture(overrides = {}) {
  return {
    id: 100,
    path: ".github/workflows/ci.yml",
    state: "active",
    ...overrides,
  };
}

function runFixture(overrides = {}) {
  return {
    id: 200,
    workflow_id: 100,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    head_sha: HEAD_SHA,
    pull_requests: [{ number: 450 }],
    ...overrides,
  };
}

{
  const valid = mergeBatch.validateActionRequiredRuns(
    [runFixture()],
    [workflowFixture()],
    450,
    HEAD_SHA,
  );
  assert.strictEqual(valid.length, 1);

  for (const [label, run, workflows, pattern] of [
    ["unrelated PR", runFixture({ pull_requests: [{ number: 451 }] }), [workflowFixture()], /does not contain #450/],
    ["wrong SHA", runFixture({ head_sha: BASE_SHA }), [workflowFixture()], /head SHA/],
    ["wrong event", runFixture({ event: "push" }), [workflowFixture()], /not pull_request/],
    ["unknown path", runFixture({ path: ".github/workflows/evil.yml" }), [workflowFixture()], /not allowlisted/],
    ["ID mismatch", runFixture({ workflow_id: 101 }), [workflowFixture()], /workflow ID/],
    ["path mismatch", runFixture(), [workflowFixture({ path: ".github/workflows/codeql.yml" })], /mapping/],
  ]) {
    assert.throws(
      () => mergeBatch.validateActionRequiredRuns([run], workflows, 450, HEAD_SHA),
      pattern,
      label,
    );
  }
}

function approvalDependencies(overrides = {}) {
  const record = {
    status: "A",
    old_path: null,
    new_path: "skills/example/SKILL.md",
    old_mode: "000000",
    new_mode: "100644",
    old_oid: ZERO_SHA,
    new_oid: BLOB_SHA,
  };
  return {
    fetchPullRequestObjects() {},
    readRawChangeRecords() { return [record]; },
    resolveBlobSizes() { return new Map([[BLOB_SHA, 100]]); },
    listWorkflowDefinitions() { return [workflowFixture()]; },
    listActionRequiredRuns() { return [runFixture()]; },
    getHeadSha() { return HEAD_SHA; },
    approveWorkflowRun() {},
    ...overrides,
  };
}

{
  const prDetails = { number: 450, baseRefOid: BASE_SHA, headRefOid: HEAD_SHA };
  const supportRecord = {
    status: "M",
    old_path: "skills/example/references/guide.md",
    new_path: "skills/example/references/guide.md",
    old_mode: "100644",
    new_mode: "100644",
    old_oid: BASE_SHA,
    new_oid: BLOB_SHA,
  };
  const dependencies = approvalDependencies({
    readRawChangeRecords() { return [supportRecord]; },
    resolveBlobSizes() { return new Map([[BASE_SHA, 100], [BLOB_SHA, 100]]); },
  });
  assert.throws(
    () => mergeBatch.approveActionRequiredRuns("/repo", "owner/repo", prDetails, { dependencies }),
    /--reviewed-head/,
    "skill support content must require an exact-head maintainer attestation",
  );
  const approved = mergeBatch.approveActionRequiredRuns("/repo", "owner/repo", prDetails, {
    dependencies,
    reviewedHeads: [HEAD_SHA],
    dryRun: true,
  });
  assert.strictEqual(approved.policy.requiresHumanReview, true);
  assert.deepStrictEqual(approved.policy.canonicalSkillChanges, []);
}

{
  const prDetails = { number: 450, baseRefOid: BASE_SHA, headRefOid: HEAD_SHA };
  let approvals = 0;
  let headReads = 0;
  const dependencies = approvalDependencies({
    getHeadSha() { headReads += 1; return HEAD_SHA; },
    approveWorkflowRun() { approvals += 1; },
  });
  assert.throws(
    () => mergeBatch.approveActionRequiredRuns("/repo", "owner/repo", prDetails, { dependencies }),
    /--reviewed-head/,
  );
  assert.throws(
    () => mergeBatch.approveActionRequiredRuns("/repo", "owner/repo", prDetails, {
      dependencies,
      reviewedHeads: [BASE_SHA],
    }),
    /--reviewed-head/,
    "a stale but full reviewed head must fail closed",
  );
  assert.strictEqual(approvals, 0);

  const result = mergeBatch.approveActionRequiredRuns("/repo", "owner/repo", prDetails, {
    dependencies,
    reviewedHeads: [HEAD_SHA],
  });
  assert.strictEqual(approvals, 1);
  assert.strictEqual(headReads, 2);
  assert.deepStrictEqual(result.approvedRuns.map((run) => run.id), [200]);
}

{
  const prDetails = { number: 450, baseRefOid: BASE_SHA, headRefOid: HEAD_SHA };
  let approvals = 0;
  const result = mergeBatch.approveActionRequiredRuns("/repo", "owner/repo", prDetails, {
    dependencies: approvalDependencies({ approveWorkflowRun() { approvals += 1; } }),
    reviewedHeads: [HEAD_SHA],
    dryRun: true,
  });
  assert.strictEqual(approvals, 0);
  assert.deepStrictEqual(result.approvedRuns, []);
  assert.strictEqual(result.runs.length, 1);
}

{
  const prDetails = { number: 450, baseRefOid: BASE_SHA, headRefOid: HEAD_SHA };
  let approvals = 0;
  const dependencies = approvalDependencies({
    listActionRequiredRuns() {
      return [runFixture({ pull_requests: [{ number: 999 }] })];
    },
    approveWorkflowRun() { approvals += 1; },
  });
  assert.throws(
    () => mergeBatch.approveActionRequiredRuns("/repo", "owner/repo", prDetails, {
      dependencies,
      reviewedHeads: [HEAD_SHA],
    }),
    /does not contain #450/,
  );
  assert.strictEqual(approvals, 0);
}

{
  const calls = [];
  mergeBatch.fetchPullRequestObjects("/repo", BASE_SHA, HEAD_SHA, {
    runCommand(command, args) { calls.push([command, args]); },
  });
  assert.deepStrictEqual(calls[0], [
    "git",
    ["fetch", "--no-tags", "--no-write-fetch-head", "origin", BASE_SHA, HEAD_SHA],
  ]);
  assert.ok(calls.every(([, args]) => !args.includes("checkout")));
  assert.deepStrictEqual(calls.slice(1).map(([, args]) => args), [
    ["cat-file", "-e", `${BASE_SHA}^{commit}`],
    ["cat-file", "-e", `${HEAD_SHA}^{commit}`],
  ]);
}

{
  const prDetails = { number: 450, baseRefOid: BASE_SHA, headRefOid: HEAD_SHA };
  let approvals = 0;
  const dependencies = approvalDependencies({
    getHeadSha() { return BASE_SHA; },
    approveWorkflowRun() { approvals += 1; },
  });
  assert.throws(
    () => mergeBatch.approveActionRequiredRuns("/repo", "owner/repo", prDetails, {
      dependencies,
      reviewedHeads: [HEAD_SHA],
    }),
    /head changed before approvals/,
  );
  assert.strictEqual(approvals, 0);
}

{
  const prDetails = { number: 450, baseRefOid: BASE_SHA, headRefOid: HEAD_SHA };
  let approvals = 0;
  const dependencies = approvalDependencies({
    classifyChangeRecords() {
      return { approvalSafe: false, reasons: ["record_0:new_executable_mode"] };
    },
    approveWorkflowRun() { approvals += 1; },
  });
  assert.throws(
    () => mergeBatch.approveActionRequiredRuns("/repo", "owner/repo", prDetails, {
      dependencies,
      reviewedHeads: [HEAD_SHA],
    }),
    /not fork-approval-safe/,
  );
  assert.strictEqual(approvals, 0);
}

console.log("ok");
