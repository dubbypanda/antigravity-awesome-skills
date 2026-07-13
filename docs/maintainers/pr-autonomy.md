# Pull Request Autonomy

This document describes the repository's staged path toward lower-maintenance pull-request handling. The first stage is evidence and routing, not automatic merge.

## Trust Model

Pull-request CI is unprivileged: it has read-only repository permissions and receives no repository secrets. Reports produced there are useful to contributors and maintainers, but they are explicitly advisory because the pull-request checkout can modify the reporting code itself.

Any privileged or local maintainer action must recompute its decision from trusted `main` code against immutable base and head object IDs. It must not consume the pull-request-generated decision artifact as authorization.

## Evidence Artifacts

The `pr-evidence` CI job produces:

- `preflight.json`: changed files, broad change categories, source-only policy state, and pull-request template state;
- `changed-skills.json`: before/after evidence for changed canonical skills, including audit findings, score, security flags, risk, provenance, and deterministic regression reasons;
- `decision-manifest.json`: a schema-versioned shadow routing recommendation.

The manifest always contains:

```json
{
  "schema_version": 1,
  "mode": "shadow",
  "untrusted_advisory": true,
  "route": "human_review"
}
```

The `untrusted_advisory` marker is intentional. No workflow, merge command, or future bot may treat the artifact as privileged authorization.

## Shadow Routes

- `block`: deterministic repository policy failed, such as a newly introduced changed-skill regression or a direct edit to generated artifacts.
- `human_review`: the change is valid enough to inspect, but it touches canonical skill content, sensitive paths, uncertain provenance/risk, or lacks semantic review.
- `eligible_for_later_automation`: deterministic evidence found no blocker and the change belongs to a low-risk class. In the current stage this remains advisory and does not enable auto-merge.

Every new or relocated skill and every canonical skill-content change requires maintainer review in v1. A `safe` risk label is not sufficient evidence for automatic merge.

## Fork Review States

The Skill Review workflow separates three outcomes:

- `review`: a semantic review actually ran using trusted base scripts;
- `manual-review-required`: semantic-review credentials were unavailable, either because the PR is from a fork or because the repository has no provider token configured, so a maintainer must review and attest to the exact head SHA.

A successful `manual-review-required` check means only that the requirement was recorded. It is not a successful semantic review.

## Maintainer Recalculation

`merge:batch` must bind workflow approval and human attestation to one full head SHA. Before approving a waiting fork run, it independently:

1. captures base and head object IDs;
2. fetches those objects without checking out pull-request code;
3. computes a complete NUL-delimited raw Git diff with full object IDs and modes;
4. rejects unsafe paths, modes, symlinks, gitlinks, executable files, unknown types, oversized blobs, incomplete metadata, or non-allowlisted workflows;
5. verifies workflow event, workflow identity, pull-request number, and head SHA;
6. re-reads the pull-request head before and after approval.

For canonical `SKILL.md` or allowlisted supporting skill-content changes, the maintainer supplies `--reviewed-head <full-sha>`. A stale, abbreviated, or mismatched SHA fails closed. The Skill Review check itself is required only for `SKILL.md` changes because that workflow is path-filtered; support-only changes still require the exact-SHA human attestation.

## Later Phases

Each phase requires evidence from the previous phase before activation:

1. Observe shadow route accuracy and false-positive rates on real pull requests.
2. Move direct-main CI, hygiene, contributor-sync, and release writers to bot pull requests or a narrowly scoped GitHub App.
3. Protect `main` and require stable checks; remove routine human and bot direct pushes.
4. Add schema-validated fork-safe semantic review whose privileged code always comes from the protected base.
5. Build deterministic release-candidate pull requests with rendering separated from publication.
6. Add immutable upstream commit/path/hash provenance and a delta-based exception ledger.
7. Consider auto-merge only for empirically proven documentation or metadata classes. New skills, security-sensitive content, workflows, installers, releases, provenance exceptions, and policy changes remain human decisions.

Merge queue is not part of the current plan. The repository is personally owned, and its workflows do not currently support a `merge_group` event.
