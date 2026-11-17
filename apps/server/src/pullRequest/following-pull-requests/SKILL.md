---
name: following-pull-requests
description: Coordinates independent issue sessions through PR review, CI and conflict revisions. Use when asked to keep issues or PRs moving until mergeable, including incremental intake and resumed follow-up. Not for a one-off fix or read-only review.
---

# Following pull requests

You are the coordinator. PinaCode owns durable watches and completion delivery; original independent sessions own fixes. Keep accepting new issues without restarting existing sessions or changing their provider/model/worktree. Use the persisted sessions and pullRequests returned with this skill, not conversation memory. A watch or endedWatch carries its issueUrl and childThreadId; the containing thread is its monitoring owner.

## Intake and revisions

- For an existing PR, recover its original session first. If no implementation session exists and the user asks for a child/node to handle repairs, create one with `session:"independent"`, even when they say “子节点” or “subagent”. A separate worktree alone does not select an independent session. Status-only tracking does not require creating an implementation session.

- For each new issue, use pinacode_delegate_task with session:"independent", issueUrl and a stable clientRequestId. Keep the user's existing provider/model choice; ask once when none was chosen. Completion wakes this coordinator. Ordinary implementation acceptance does not end PR follow-up.
- Each child must report PR URL, latest head, tests and remaining work after implementation and every push. Read the actual diff and test evidence in its original worktree. Register its PR with pinacode_watch_pull_request and followUp:{issueUrl,childThreadId}. Handle existing review comments too: the watch baselines historical remarks.
- On a watch wake or child completion, call pinacode_pr_workflow to recover this skill and persisted associations. Verify each review finding before assigning fixes. Send concrete valid findings to that same childThreadId with pinacode_thread_send; explain rejected findings. Do not create a replacement, change its execution choices, or fix the same files in the parent.
- Use queued delivery, not steering or restart, when the original session is busy. Give pinacode_thread_send a stable clientRequestId for this PR/head/finding set and reuse it on retries. Read the queued/active work before assigning overlapping findings; combine new related findings into the next revision. Do not resubmit a fix already queued, running or completed for that head. Completion delivery handles repeated revisions without a fixed round limit.

## Acceptance and waiting

- Recheck the latest head after every push. Awaiting-acceptance means only that platform evidence is clear: independently inspect diff/tests, repository review rules, reviewer eligibility and the user's additional requirements before announcing mergeability.
- Local coordinator review, a bot's no-findings comment/check, and a formal platform approval are different evidence. Neither self-review nor a bot comment substitutes for required valid approval. Recheck whether approvals remain valid after a push or dismissal. Missing/failed reads, no CI, pending human action, Drafts, unresolved blocking feedback or unknown platform restrictions are blockers, not success.
- Notify the user when the PR is mergeable; never merge without authorization. Keep watching while they decide. A later failed check, conflict, withdrawn approval or new blocking finding reopens acceptance. A phase report, new issue, quiet period or end of a turn never unwatches any other PR.
- Only merged/closed PRs or an explicit user stop end that PR's follow-up. pinacode_unwatch_pull_request stops only the named PR; do not restart stopped work because of a late wake. A paused endedWatch is blocked, not finished: report its reason and retain coordinator responsibility. Inspect the loop or credentials before explicitly resuming with pinacode_watch_pull_request.
- PinaCode's existing PR/MR adapters own monitoring. Do not use sleep, CLI watch loops or schedules to keep sessions alive. Server availability and valid host credentials are prerequisites. If workflow loading or required tools fail, report the limitation rather than silently doing a one-shot task.
