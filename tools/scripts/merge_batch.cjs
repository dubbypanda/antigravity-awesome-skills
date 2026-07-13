#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const { findProjectRoot } = require("../lib/project-root");
const { parseRawDiff } = require("../lib/git-raw-diff");
const {
  classifyChangeRecords,
  hasQualityChecklist,
} = require("../lib/workflow-contract");

const REOPEN_COMMENT =
  "Maintainer workflow refresh: closing and reopening to retrigger pull_request checks against the updated PR body.";
const DEFAULT_POLL_SECONDS = 20;
const BASE_BRANCH_MODIFIED_PATTERNS = [
  /base branch was modified/i,
  /base branch has been modified/i,
  /branch was modified/i,
];
const REQUIRED_CHECKS = [
  ["pr-policy", ["pr-policy"]],
  ["pr-evidence", ["pr-evidence"]],
  ["source-validation", ["source-validation"]],
  ["artifact-preview", ["artifact-preview"]],
];
const SKILL_REVIEW_REQUIRED = ["review", "Skill Review & Optimize", "Skill Review & Optimize / review"];
const MANUAL_REVIEW_REQUIRED = ["manual-review-required", "Skill Review / manual-review-required"];
const DISALLOWED_COAUTHOR_TRAILER_PATTERNS = [
  /<noreply@anthropic\.com>/i,
  /:\s*claude\b/i,
  /:\s*claude\s+sonnet\b/i,
];
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const APPROVAL_WORKFLOW_PATHS = new Set([
  ".github/workflows/actionlint.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/dependency-review.yml",
  ".github/workflows/skill-review.yml",
]);

function parseArgs(argv) {
  const args = {
    prs: null,
    pollSeconds: DEFAULT_POLL_SECONDS,
    dryRun: false,
    reviewedHeads: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--prs") {
      args.prs = argv[index + 1] || null;
      index += 1;
    } else if (arg === "--poll-seconds") {
      args.pollSeconds = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--reviewed-head") {
      const reviewedHead = String(argv[index + 1] || "");
      if (!FULL_SHA_PATTERN.test(reviewedHead)) {
        throw new Error("--reviewed-head must be an exact 40-character lowercase commit SHA.");
      }
      args.reviewedHeads.push(reviewedHead);
      index += 1;
    }
  }

  if (typeof args.pollSeconds !== "number" || Number.isNaN(args.pollSeconds) || args.pollSeconds <= 0) {
    args.pollSeconds = DEFAULT_POLL_SECONDS;
  }

  return args;
}

function assertFullSha(value, label) {
  if (!FULL_SHA_PATTERN.test(String(value || ""))) {
    throw new Error(`${label} must be an exact 40-character lowercase commit SHA.`);
  }
  return value;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readRepositorySlug(projectRoot) {
  const packageJson = readJson(path.join(projectRoot, "package.json"));
  const repository = packageJson.repository;
  const rawUrl =
    typeof repository === "string"
      ? repository
      : repository && typeof repository.url === "string"
        ? repository.url
        : null;

  if (!rawUrl) {
    throw new Error("package.json repository.url is required to resolve the GitHub slug.");
  }

  const match = rawUrl.match(/github\.com[:/](?<slug>[^/]+\/[^/]+?)(?:\.git)?$/i);
  if (!match?.groups?.slug) {
    throw new Error(`Could not derive a GitHub repo slug from repository url: ${rawUrl}`);
  }

  return match.groups.slug;
}

function runCommand(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input: options.input,
    stdio: options.capture
      ? ["pipe", "pipe", "pipe"]
      : options.input !== undefined
        ? ["pipe", "inherit", "inherit"]
        : ["inherit", "inherit", "inherit"],
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status !== "number" || result.status !== 0) {
    const stderr = options.capture ? result.stderr.trim() : "";
    throw new Error(stderr || `${command} ${args.join(" ")} failed with status ${result.status}`);
  }

  return options.capture ? result.stdout.trim() : "";
}

function runCommandBuffer(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: null,
    input: options.input,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status !== "number" || result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "";
    throw new Error(stderr || `${command} ${args.join(" ")} failed with status ${result.status}`);
  }
  if (!Buffer.isBuffer(result.stdout)) {
    throw new Error(`${command} did not return a raw byte buffer.`);
  }
  return result.stdout;
}

function fetchPullRequestObjects(projectRoot, baseOid, headOid, dependencies = {}) {
  const execute = dependencies.runCommand || runCommand;
  assertFullSha(baseOid, "Pull request base SHA");
  assertFullSha(headOid, "Pull request head SHA");
  execute(
    "git",
    ["fetch", "--no-tags", "--no-write-fetch-head", "origin", baseOid, headOid],
    projectRoot,
  );
  execute("git", ["cat-file", "-e", `${baseOid}^{commit}`], projectRoot);
  execute("git", ["cat-file", "-e", `${headOid}^{commit}`], projectRoot);
}

function readRawChangeRecords(projectRoot, baseOid, headOid, dependencies = {}) {
  const executeBuffer = dependencies.runCommandBuffer || runCommandBuffer;
  assertFullSha(baseOid, "Pull request base SHA");
  assertFullSha(headOid, "Pull request head SHA");
  const raw = executeBuffer(
    "git",
    ["diff", "--raw", "--no-abbrev", "-z", "-M", "--find-copies-harder", baseOid, headOid, "--"],
    projectRoot,
  );
  return parseRawDiff(raw);
}

function resolveBlobSizes(projectRoot, records, dependencies = {}) {
  const execute = dependencies.runCommand || runCommand;
  const objectIds = [...new Set(records.flatMap((record) => [record.old_oid, record.new_oid]))]
    .filter((oid) => FULL_SHA_PATTERN.test(String(oid || "")) && !/^0+$/u.test(oid));
  if (!objectIds.length) {
    throw new Error("Raw Git diff did not contain any materialized blob object IDs.");
  }

  const stdout = execute(
    "git",
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    projectRoot,
    { capture: true, input: `${objectIds.join("\n")}\n` },
  );
  const sizes = new Map();
  for (const line of String(stdout || "").split(/\r?\n/u).filter(Boolean)) {
    const match = line.match(/^(?<oid>[0-9a-f]{40}) (?<type>\S+) (?<size>\d+)$/u);
    if (!match?.groups || !objectIds.includes(match.groups.oid)) {
      throw new Error(`Unexpected git cat-file response: ${line}`);
    }
    if (match.groups.type !== "blob") {
      throw new Error(`Object ${match.groups.oid} is ${match.groups.type}, not a blob.`);
    }
    const size = Number(match.groups.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Object ${match.groups.oid} has an invalid size.`);
    }
    sizes.set(match.groups.oid, size);
  }
  for (const oid of objectIds) {
    if (!sizes.has(oid)) {
      throw new Error(`git cat-file did not return metadata for ${oid}.`);
    }
  }
  return sizes;
}

function runGhJson(projectRoot, args, options = {}) {
  const stdout = runCommand(
    "gh",
    [...args, "--json", options.jsonFields || ""].filter(Boolean),
    projectRoot,
    { capture: true, input: options.input },
  );
  return JSON.parse(stdout || "null");
}

function runGhApiJson(projectRoot, args, options = {}) {
  const ghArgs = ["api", ...args];
  if (options.paginate) {
    ghArgs.push("--paginate");
  }
  if (options.slurp) {
    ghArgs.push("--slurp");
  }
  const stdout = runCommand("gh", ghArgs, projectRoot, { capture: true, input: options.input });
  return JSON.parse(stdout || "null");
}

function flattenGhSlurpPayload(payload) {
  if (!Array.isArray(payload)) {
    return [];
  }

  const flattened = [];
  for (const page of payload) {
    if (Array.isArray(page)) {
      flattened.push(...page);
    } else if (page && typeof page === "object") {
      flattened.push(page);
    }
  }
  return flattened;
}

function ensureOnMainAndClean(projectRoot) {
  const branch = runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], projectRoot, {
    capture: true,
  });
  if (branch !== "main") {
    throw new Error(`merge-batch must run from main. Current branch: ${branch}`);
  }

  const status = runCommand(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    projectRoot,
    { capture: true },
  );
  if (status) {
    throw new Error("merge-batch requires a clean tracked working tree before starting.");
  }
}

function parsePrList(prs) {
  if (!prs) {
    throw new Error("Usage: merge_batch.cjs --prs 450,449,446,451");
  }

  const parsed = prs
    .split(/[\s,]+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0);

  if (!parsed.length) {
    throw new Error("No valid PR numbers were provided.");
  }

  return [...new Set(parsed)];
}

function extractSummaryBlock(body) {
  const text = String(body || "").replace(/\r\n/g, "\n").trim();
  if (!text) {
    return "";
  }

  const sectionMatch = text.match(/^\s*##\s+/m);
  if (!sectionMatch) {
    return text;
  }

  const prefix = text.slice(0, sectionMatch.index).trimEnd();
  return prefix;
}

function extractTemplateSections(templateContent) {
  const text = String(templateContent || "").replace(/\r\n/g, "\n").trim();
  const sectionMatch = text.match(/^\s*##\s+/m);
  if (!sectionMatch) {
    return text;
  }

  return text.slice(sectionMatch.index).trim();
}

function normalizePrBody(body, templateContent) {
  const summary = extractSummaryBlock(body);
  const templateSections = extractTemplateSections(templateContent);

  if (!summary) {
    return templateSections;
  }

  return `${summary}\n\n${templateSections}`.trim();
}

function stripDisallowedCoauthorTrailers(body) {
  return String(body || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      if (!/^\s*co-authored-by:/i.test(line)) {
        return true;
      }
      return !DISALLOWED_COAUTHOR_TRAILER_PATTERNS.some((pattern) => pattern.test(line));
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildSquashMergeSubject(prDetails) {
  return `${String(prDetails.title || `PR #${prDetails.number}`).trim()} (#${prDetails.number})`;
}

function buildSquashMergeBody(prDetails) {
  const summary = extractSummaryBlock(prDetails.body);
  return stripDisallowedCoauthorTrailers(summary);
}

function loadPullRequestTemplate(projectRoot) {
  return fs.readFileSync(path.join(projectRoot, ".github", "PULL_REQUEST_TEMPLATE.md"), "utf8");
}

function loadPullRequestDetails(projectRoot, repoSlug, prNumber) {
  const details = runGhJson(projectRoot, ["pr", "view", String(prNumber)], {
    jsonFields: [
      "body",
      "baseRefOid",
      "mergeStateStatus",
      "mergeable",
      "number",
      "title",
      "headRefOid",
      "url",
    ].join(","),
  });
  return details;
}

function needsBodyRefresh(prDetails) {
  return !hasQualityChecklist(prDetails.body);
}

function getRequiredCheckAliases(prDetails, options = {}) {
  const aliases = REQUIRED_CHECKS.map(([, value]) => value);
  if (prDetails.hasSkillChanges) {
    aliases.push({
      label: "review",
      aliases: SKILL_REVIEW_REQUIRED,
      acceptedConclusions: ["success"],
      alternatives: options.allowManualReview
        ? [{
            aliases: MANUAL_REVIEW_REQUIRED,
            acceptedConclusions: ["success"],
          }]
        : [],
    });
  }
  return aliases;
}

function mergeableIsConflict(prDetails) {
  const mergeable = String(prDetails.mergeable || "").toUpperCase();
  const mergeState = String(prDetails.mergeStateStatus || "").toUpperCase();
  return mergeable === "CONFLICTING" || mergeState === "DIRTY";
}

function selectLatestCheckRuns(checkRuns) {
  const byName = new Map();

  for (const run of checkRuns) {
    const name = String(run?.name || "");
    if (!name) {
      continue;
    }

    const previous = byName.get(name);
    if (!previous) {
      byName.set(name, run);
      continue;
    }

    const currentKey = run.completed_at || run.started_at || run.created_at || "";
    const previousKey = previous.completed_at || previous.started_at || previous.created_at || "";

    if (currentKey > previousKey || (currentKey === previousKey && Number(run.id || 0) > Number(previous.id || 0))) {
      byName.set(name, run);
    }
  }

  return byName;
}

function checkRunMatchesAliases(checkRun, aliases) {
  const name = String(checkRun?.name || "");
  return aliases.some((alias) => name === alias || name.endsWith(` / ${alias}`));
}

function normalizeRequiredCheckSpec(requiredCheck) {
  if (Array.isArray(requiredCheck)) {
    return {
      label: requiredCheck[0],
      aliases: requiredCheck,
      acceptedConclusions: ["success"],
      alternatives: [],
      blockingAliases: [],
    };
  }
  if (!requiredCheck || typeof requiredCheck !== "object" || !Array.isArray(requiredCheck.aliases)) {
    throw new Error("Required check specification is malformed.");
  }
  return {
    label: String(requiredCheck.label || requiredCheck.aliases[0] || "check"),
    aliases: requiredCheck.aliases,
    acceptedConclusions: requiredCheck.acceptedConclusions || ["success"],
    alternatives: Array.isArray(requiredCheck.alternatives) ? requiredCheck.alternatives : [],
    blockingAliases: Array.isArray(requiredCheck.blockingAliases) ? requiredCheck.blockingAliases : [],
  };
}

function summarizeCheckCandidate(latestRuns, aliases, acceptedConclusions) {
  const candidates = latestRuns.filter((run) => checkRunMatchesAliases(run, aliases));
  if (!candidates.length) {
    return { state: "missing", conclusion: null, run: null };
  }

  const successful = candidates.find((run) => (
    String(run?.status || "").toLowerCase() === "completed" &&
    acceptedConclusions.includes(String(run?.conclusion || "").toLowerCase())
  ));
  if (successful) {
    return {
      state: "success",
      conclusion: String(successful.conclusion || "").toLowerCase(),
      run: successful,
    };
  }

  const pending = candidates.find((run) => String(run?.status || "").toLowerCase() !== "completed");
  if (pending) {
    return {
      state: "pending",
      conclusion: String(pending.conclusion || "").toLowerCase(),
      run: pending,
    };
  }

  const failed = candidates.find((run) => {
    const conclusion = String(run?.conclusion || "").toLowerCase();
    return conclusion && conclusion !== "skipped";
  });
  if (failed) {
    return {
      state: "failed",
      conclusion: String(failed.conclusion || "").toLowerCase(),
      run: failed,
    };
  }

  return {
    state: "missing",
    conclusion: "skipped",
    run: candidates[0],
  };
}

function summarizeRequiredCheckRuns(checkRuns, requiredAliases) {
  const latestByName = selectLatestCheckRuns(checkRuns);
  const summaries = [];

  const latestRuns = [...latestByName.values()];
  for (const requiredCheck of requiredAliases) {
    const spec = normalizeRequiredCheckSpec(requiredCheck);
    const blocker = summarizeCheckCandidate(latestRuns, spec.blockingAliases, []);
    if (blocker.state === "failed" || blocker.state === "pending") {
      summaries.push({ label: spec.label, ...blocker });
      continue;
    }
    const primary = summarizeCheckCandidate(latestRuns, spec.aliases, spec.acceptedConclusions);
    if (primary.state === "success" || primary.state === "failed" || primary.state === "pending") {
      summaries.push({ label: spec.label, ...primary });
      continue;
    }

    let alternativeSummary = null;
    for (const alternative of spec.alternatives) {
      const candidate = summarizeCheckCandidate(
        latestRuns,
        alternative.aliases || [],
        alternative.acceptedConclusions || ["success"],
      );
      if (candidate.state === "success") {
        alternativeSummary = candidate;
        break;
      }
      if (!alternativeSummary || candidate.state === "pending" || candidate.state === "failed") {
        alternativeSummary = candidate;
      }
    }
    if (!spec.alternatives.length && primary.conclusion === "skipped") {
      summaries.push({ label: spec.label, ...primary, state: "failed" });
    } else {
      summaries.push({ label: spec.label, ...(alternativeSummary || primary) });
    }
  }

  return summaries;
}

function formatCheckSummary(summaries) {
  return summaries
    .map((summary) => {
      if (summary.state === "success") {
        return `${summary.label}: ${summary.conclusion || "success"}`;
      }
      if (summary.state === "pending") {
        return `${summary.label}: pending (${summary.conclusion || "in progress"})`;
      }
      if (summary.state === "failed") {
        return `${summary.label}: failed (${summary.conclusion || "unknown"})`;
      }
      return `${summary.label}: missing`;
    })
    .join(", ");
}

function getHeadSha(projectRoot, repoSlug, prNumber) {
  const details = runGhJson(projectRoot, ["pr", "view", String(prNumber)], {
    jsonFields: "headRefOid",
  });
  return details.headRefOid;
}

function listActionRequiredRuns(projectRoot, repoSlug, headSha) {
  const payload = runGhApiJson(projectRoot, [
    `repos/${repoSlug}/actions/runs?head_sha=${headSha}&status=action_required&per_page=100`,
  ], {
    paginate: true,
    slurp: true,
  });

  const runs = flattenGhSlurpPayload(payload).filter((run) => Number.isInteger(Number(run?.id)));
  const seen = new Set();
  return runs.filter((run) => {
    const id = Number(run.id);
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function listWorkflowDefinitions(projectRoot, repoSlug) {
  const payload = runGhApiJson(projectRoot, [
    `repos/${repoSlug}/actions/workflows?per_page=100`,
  ]);
  return Array.isArray(payload?.workflows) ? payload.workflows : [];
}

function validateActionRequiredRuns(
  runs,
  workflows,
  prNumber,
  headSha,
  allowedWorkflowPaths = APPROVAL_WORKFLOW_PATHS,
) {
  const workflowById = new Map(
    workflows
      .filter((workflow) => Number.isInteger(Number(workflow?.id)))
      .map((workflow) => [Number(workflow.id), workflow]),
  );
  const validated = [];

  for (const run of runs) {
    const runId = Number(run?.id);
    const workflowId = Number(run?.workflow_id);
    const runPath = typeof run?.path === "string" ? run.path : "";
    const workflow = workflowById.get(workflowId);
    const prNumbers = Array.isArray(run?.pull_requests)
      ? run.pull_requests.map((entry) => Number(entry?.number)).filter(Number.isInteger)
      : [];
    const reasons = [];

    if (!Number.isInteger(runId) || runId <= 0) {
      reasons.push("missing run ID");
    }
    if (!workflow || !Number.isInteger(workflowId)) {
      reasons.push("workflow ID is not present in the trusted workflow inventory");
    }
    if (!allowedWorkflowPaths.has(runPath)) {
      reasons.push(`workflow path ${runPath || "<missing>"} is not allowlisted`);
    }
    if (workflow && (workflow.path !== runPath || !allowedWorkflowPaths.has(workflow.path))) {
      reasons.push("workflow ID/path mapping does not match the allowlist");
    }
    if (workflow && workflow.state !== "active") {
      reasons.push(`workflow is not active (${workflow.state || "missing state"})`);
    }
    if (run?.event !== "pull_request") {
      reasons.push(`event is ${run?.event || "missing"}, not pull_request`);
    }
    if (run?.head_sha !== headSha) {
      reasons.push("head SHA does not match the captured pull request head");
    }
    if (!prNumbers.includes(prNumber)) {
      reasons.push(`pull request metadata does not contain #${prNumber}`);
    }
    if (reasons.length) {
      throw new Error(`Refusing workflow run ${runId || "<unknown>"}: ${reasons.join("; ")}.`);
    }
    validated.push(run);
  }

  return validated;
}

function approveWorkflowRun(projectRoot, repoSlug, run) {
  runCommand(
    "gh",
    ["api", "-X", "POST", `repos/${repoSlug}/actions/runs/${run.id}/approve`],
    projectRoot,
  );
}

function assertUnchangedHead(actual, expected, phase, prNumber) {
  assertFullSha(actual, `PR #${prNumber} ${phase} head SHA`);
  if (actual !== expected) {
    throw new Error(
      `PR #${prNumber} head changed ${phase}: expected ${expected}, received ${actual}. Rerun merge:batch and review the new head.`,
    );
  }
}

function approveActionRequiredRuns(projectRoot, repoSlug, prDetails, options = {}) {
  const prNumber = Number(prDetails?.number);
  const baseOid = assertFullSha(prDetails?.baseRefOid, `PR #${prNumber} base SHA`);
  const headOid = assertFullSha(prDetails?.headRefOid, `PR #${prNumber} head SHA`);
  const dependencies = options.dependencies || {};
  const fetchObjects = dependencies.fetchPullRequestObjects || fetchPullRequestObjects;
  const readRecords = dependencies.readRawChangeRecords || readRawChangeRecords;
  const getSizes = dependencies.resolveBlobSizes || resolveBlobSizes;
  const classifyRecords = dependencies.classifyChangeRecords || classifyChangeRecords;
  const getCurrentHead = dependencies.getHeadSha || getHeadSha;
  const getRuns = dependencies.listActionRequiredRuns || listActionRequiredRuns;
  const getWorkflows = dependencies.listWorkflowDefinitions || listWorkflowDefinitions;
  const approveRun = dependencies.approveWorkflowRun || approveWorkflowRun;

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("Pull request number is required for workflow approval.");
  }

  fetchObjects(projectRoot, baseOid, headOid, dependencies);
  const records = readRecords(projectRoot, baseOid, headOid, dependencies);
  const blobSizes = getSizes(projectRoot, records, dependencies);
  const policy = classifyRecords(records, { blobSizes });
  if (!policy?.approvalSafe) {
    const reasons = Array.isArray(policy?.reasons) && policy.reasons.length
      ? policy.reasons.slice(0, 12).join(", ")
      : "unclassified local diff";
    throw new Error(`PR #${prNumber} local base-to-head diff is not fork-approval-safe: ${reasons}.`);
  }

  const reviewedHeads = new Set(options.reviewedHeads || []);
  if (policy.requiresHumanReview && !reviewedHeads.has(headOid)) {
    throw new Error(
      `PR #${prNumber} changes canonical skill content. Re-run with --reviewed-head ${headOid} after reviewing that exact full SHA.`,
    );
  }

  const workflows = getWorkflows(projectRoot, repoSlug);
  const runs = getRuns(projectRoot, repoSlug, headOid);
  const validatedRuns = validateActionRequiredRuns(
    runs,
    workflows,
    prNumber,
    headOid,
    options.allowedWorkflowPaths || APPROVAL_WORKFLOW_PATHS,
  );

  assertUnchangedHead(getCurrentHead(projectRoot, repoSlug, prNumber), headOid, "before approvals", prNumber);
  if (!options.dryRun) {
    for (const run of validatedRuns) {
      approveRun(projectRoot, repoSlug, run);
    }
  }
  assertUnchangedHead(getCurrentHead(projectRoot, repoSlug, prNumber), headOid, "after approvals", prNumber);

  return {
    records,
    policy,
    runs: validatedRuns,
    approvedRuns: options.dryRun ? [] : validatedRuns,
  };
}

function listCheckRuns(projectRoot, repoSlug, headSha) {
  const payload = runGhApiJson(projectRoot, [
    `repos/${repoSlug}/commits/${headSha}/check-runs?per_page=100`,
  ]);
  return Array.isArray(payload?.check_runs) ? payload.check_runs : [];
}

async function waitForRequiredChecks(
  projectRoot,
  repoSlug,
  headSha,
  requiredAliases,
  pollSeconds,
  maxAttempts = 180,
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const checkRuns = listCheckRuns(projectRoot, repoSlug, headSha);
    const summaries = summarizeRequiredCheckRuns(checkRuns, requiredAliases);
    const pending = summaries.filter((summary) => summary.state === "pending" || summary.state === "missing");
    const failed = summaries.filter((summary) => summary.state === "failed");

    console.log(`[merge-batch] Checks for ${headSha}: ${formatCheckSummary(summaries)}`);

    if (failed.length) {
      throw new Error(
        `Required checks failed for ${headSha}: ${failed.map((item) => `${item.label} (${item.conclusion || "failed"})`).join(", ")}`,
      );
    }

    if (!pending.length) {
      return summaries;
    }

    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }

  throw new Error(`Timed out waiting for required checks on ${headSha}.`);
}

function patchPrBody(projectRoot, repoSlug, prNumber, body) {
  const payload = JSON.stringify({ body });
  runCommand(
    "gh",
    ["api", `repos/${repoSlug}/pulls/${prNumber}`, "-X", "PATCH", "--input", "-"],
    projectRoot,
    { input: payload },
  );
}

function closeAndReopenPr(projectRoot, prNumber) {
  runCommand("gh", ["pr", "close", String(prNumber), "--comment", REOPEN_COMMENT], projectRoot);
  runCommand("gh", ["pr", "reopen", String(prNumber)], projectRoot);
}

function isRetryableMergeError(error) {
  const message = String(error?.message || error || "");
  return BASE_BRANCH_MODIFIED_PATTERNS.some((pattern) => pattern.test(message));
}

function gitCheckoutMain(projectRoot) {
  runCommand("git", ["checkout", "main"], projectRoot);
}

function gitPullMain(projectRoot) {
  runCommand("git", ["pull", "--ff-only", "origin", "main"], projectRoot);
}

function syncContributors(projectRoot) {
  runCommand(
    process.execPath,
    [
      path.join(projectRoot, "tools", "scripts", "run-python.js"),
      path.join(projectRoot, "tools", "scripts", "sync_contributors.py"),
    ],
    projectRoot,
  );
}

function commitAndPushReadmeIfChanged(projectRoot) {
  const status = runCommand("git", ["status", "--porcelain", "--untracked-files=no"], projectRoot, {
    capture: true,
  });

  if (!status) {
    return { changed: false };
  }

  const lines = status.split(/\r?\n/).filter(Boolean);
  const unexpected = lines.filter((line) => !line.includes("README.md"));
  if (unexpected.length) {
    throw new Error(`merge-batch expected sync:contributors to touch README.md only. Unexpected drift: ${unexpected.join(", ")}`);
  }

  runCommand("git", ["add", "README.md"], projectRoot);
  const staged = runCommand("git", ["diff", "--cached", "--name-only"], projectRoot, { capture: true });
  if (!staged.includes("README.md")) {
    return { changed: false };
  }

  runCommand("git", ["commit", "-m", "chore: sync contributor credits after merge batch"], projectRoot);
  runCommand("git", ["push", "origin", "main"], projectRoot);
  return { changed: true };
}

async function mergePullRequest(projectRoot, repoSlug, prNumber, options) {
  const template = loadPullRequestTemplate(projectRoot);
  let prDetails = loadPullRequestDetails(projectRoot, repoSlug, prNumber);

  console.log(`[merge-batch] PR #${prNumber}: ${prDetails.title}`);

  if (mergeableIsConflict(prDetails)) {
    throw new Error(`PR #${prNumber} is in conflict state; resolve conflicts on the PR branch before merging.`);
  }

  let bodyRefreshed = false;
  if (needsBodyRefresh(prDetails)) {
    const normalizedBody = normalizePrBody(prDetails.body, template);
    if (!options.dryRun) {
      patchPrBody(projectRoot, repoSlug, prNumber, normalizedBody);
      closeAndReopenPr(projectRoot, prNumber);
    }
    bodyRefreshed = true;
    console.log(`[merge-batch] PR #${prNumber}: refreshed PR body and retriggered checks.`);
    prDetails = loadPullRequestDetails(projectRoot, repoSlug, prNumber);
  }

  const approval = approveActionRequiredRuns(projectRoot, repoSlug, prDetails, {
    dryRun: options.dryRun,
    reviewedHeads: options.reviewedHeads,
    dependencies: options.approvalDependencies,
  });
  const headSha = prDetails.headRefOid;
  const approvedRuns = approval.approvedRuns;
  // The Skill Review workflow is path-filtered to SKILL.md. Supporting skill
  // content still requires exact-head human attestation, but has no review
  // check run to wait for.
  prDetails.hasSkillChanges = approval.policy.canonicalSkillChanges.length > 0;
  if (approvedRuns.length) {
    console.log(
      `[merge-batch] PR #${prNumber}: approved ${approvedRuns.length} fork run(s) waiting on action_required.`,
    );
  }

  const requiredCheckAliases = getRequiredCheckAliases(prDetails, {
    allowManualReview: approval.policy.requiresHumanReview &&
      new Set(options.reviewedHeads || []).has(headSha),
  });
  if (!options.dryRun) {
    await waitForRequiredChecks(projectRoot, repoSlug, headSha, requiredCheckAliases, options.pollSeconds);
  }

  if (options.dryRun) {
    console.log(`[merge-batch] PR #${prNumber}: dry run complete, skipping merge and post-merge sync.`);
    return {
      prNumber,
      bodyRefreshed,
      merged: false,
      approvedRuns: [],
      followUp: { changed: false },
    };
  }

  let merged = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (!options.dryRun) {
        runCommand(
          "gh",
          [
            "pr",
            "merge",
            String(prNumber),
            "--squash",
            "--subject",
            buildSquashMergeSubject(prDetails),
            "--body",
            buildSquashMergeBody(prDetails),
            "--match-head-commit",
            headSha,
          ],
          projectRoot,
        );
      }
      merged = true;
      break;
    } catch (error) {
      if (!isRetryableMergeError(error) || attempt === 3) {
        throw error;
      }

      console.log(`[merge-batch] PR #${prNumber}: base branch changed, refreshing main and retrying merge.`);
      gitCheckoutMain(projectRoot);
      gitPullMain(projectRoot);
      prDetails = loadPullRequestDetails(projectRoot, repoSlug, prNumber);
      const refreshedSha = prDetails.headRefOid || headSha;
      if (refreshedSha !== headSha) {
        throw new Error(
          `PR #${prNumber} head changed during merge retry. Rerun merge:batch and review ${refreshedSha}.`,
        );
      }
      if (!options.dryRun) {
        await waitForRequiredChecks(projectRoot, repoSlug, refreshedSha, requiredCheckAliases, options.pollSeconds);
      }
    }
  }

  if (!merged) {
    throw new Error(`Failed to merge PR #${prNumber}.`);
  }

  console.log(`[merge-batch] PR #${prNumber}: merged.`);

  gitCheckoutMain(projectRoot);
  gitPullMain(projectRoot);
  syncContributors(projectRoot);

  const followUp = commitAndPushReadmeIfChanged(projectRoot);
  if (followUp.changed) {
    console.log(`[merge-batch] PR #${prNumber}: README follow-up committed and pushed.`);
  }

  return {
    prNumber,
    bodyRefreshed,
    merged,
    approvedRuns: approvedRuns.map((run) => run.id),
    followUp,
  };
}

async function runBatch(projectRoot, prNumbers, options = {}) {
  const repoSlug = readRepositorySlug(projectRoot);
  const results = [];

  ensureOnMainAndClean(projectRoot);

  for (const prNumber of prNumbers) {
    const result = await mergePullRequest(projectRoot, repoSlug, prNumber, options);
    results.push(result);
  }

  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = findProjectRoot(__dirname);
  const prNumbers = parsePrList(args.prs);

  if (args.dryRun) {
    console.log(`[merge-batch] Dry run for PRs: ${prNumbers.join(", ")}`);
  }

  const results = await runBatch(projectRoot, prNumbers, {
    dryRun: args.dryRun,
    pollSeconds: args.pollSeconds,
    reviewedHeads: args.reviewedHeads,
  });

  console.log(
    `[merge-batch] Completed ${results.length} PR(s): ${results.map((result) => `#${result.prNumber}`).join(", ")}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[merge-batch] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  approvalWorkflowPaths: APPROVAL_WORKFLOW_PATHS,
  approveActionRequiredRuns,
  approveWorkflowRun,
  assertFullSha,
  baseBranchModifiedPatterns: BASE_BRANCH_MODIFIED_PATTERNS,
  buildSquashMergeBody,
  buildSquashMergeSubject,
  checkRunMatchesAliases,
  closeAndReopenPr,
  commitAndPushReadmeIfChanged,
  ensureOnMainAndClean,
  extractSummaryBlock,
  extractTemplateSections,
  formatCheckSummary,
  fetchPullRequestObjects,
  getRequiredCheckAliases,
  gitCheckoutMain,
  gitPullMain,
  isRetryableMergeError,
  listActionRequiredRuns,
  listCheckRuns,
  listWorkflowDefinitions,
  loadPullRequestDetails,
  loadPullRequestTemplate,
  mergePullRequest,
  mergeableIsConflict,
  normalizePrBody,
  parseArgs,
  parsePrList,
  parseRawDiff,
  readRawChangeRecords,
  readRepositorySlug,
  runCommand,
  runCommandBuffer,
  runBatch,
  selectLatestCheckRuns,
  stripDisallowedCoauthorTrailers,
  summarizeRequiredCheckRuns,
  validateActionRequiredRuns,
  waitForRequiredChecks,
  resolveBlobSizes,
};
