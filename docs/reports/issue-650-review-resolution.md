# issue 650: F1, F2 and N1 review resolution

The branch now contains the complete independent-review chain (`2c893641b6`,
`2334ed117c`), with the message extension rebased on top. Commit `2334ed117c` is
only the review's clarification delta; rebasing onto that commit also brings in
the preceding commit that creates the two review files. No path shim was created.
`issue-650-review.md` remains the historical review of `9ce293ec`.

## F1: correct the realistic last-served state

The earlier conditional tests proved that cached `[dropped §8§]` must preserve 8,
but that is not the realistic end of the reported duplicate sequence. Once a lost
owner minted active tag 154 and served it, the last-served representation was
**154 active**. Keeping 8 dropped by manual deletion performs a cache bust; it is
not byte-identical.

Both tool and message identity folds now keep the proven survivor's status.
`foldPiIdentityDuplicate` calls `foldDuplicateIntoSurvivor` with
`propagateDroppedStatus=false`. If the deleted row carried an executed drop while
the survivor is active, the drop becomes a pending operation on the survivor.
Existing pending operations are still retargeted/deduplicated by the ordinary
fold code. Neither executed nor queued reduction intent is discarded.

Adoption reports every folded survivor as protected for the current pass. The
first-application target view blocks its drop/truncate/edit methods and its
content setter, and pending/heuristic protection includes it. Frozen replay still
uses the unmodified target view. Thus the repair request retains the active
bytes, subsequent defer passes stay identical, and a later independently
permitted execute can consume the restored drop.

The independent review's realistic-154 `test.failing` is now a normal passing
test. Its partner now checks the queued drop; the survivor matrix retains all
number/status assertions and checks drop debt instead of expecting ten safe
cases to refuse. F1 applies identically to message tags.

## No cached bytes: one deliberate rebuild, approved policy

I proposed an offline, backed-up doctor repair because a cumulative served-number
ledger cannot prove the most recent array. The parent selected automatic repair
instead, scoped to the otherwise-permanent absence-of-evidence case. The tradeoff
is explicit: when exact last-served bytes are unavailable, **newest minted number**
is a recovery policy, not a byte-identical proof. An offline doctor can be added
later as an extra tool; none is built here.

The normal context handler may use that policy only when:

- ordinary identity matching already proves which fallback/real rows describe
  the same call or message part;
- neither a cached survivor nor one unambiguous served receipt authorizes a normal
  fold; and
- no nonempty, digest-correlated last-returned array is available.

A present but contradictory, wrong-call or otherwise ambiguous cached body does
not authorize guessing. Low-level adoption remains fail-closed unless the caller
explicitly declares an unproven rebuilding survivor. The repair keeps the newest
row's status and requeues losing drop/operation debt.

This request becomes **execute**, with `bustedThisPass=true` and canonical pass
reason `tag_identity_repair`. If m[0]/m[1] injection is enabled, its prepared/cached
prefix is discarded so the wire pass rematerializes managed history. There is no
raw/unreduced fallback; existing fit checks and host-abort rules still apply.

The repair log is one line naming the session, kept/removed numbers and
`tag identity repair without last-served evidence`. The canonical materialization
reason is recorded in the normal Pi transform-decision path, allowing status and
cache-bust analysis to attribute the rewrite to identity recovery instead of a
mysterious defer change.

## Named no-loop guard

`pi-tag-identity-repair-once` is durable and keyed by logical identity, not the tag
number: tool `(real assistant-entry id, call id)` or message `(real entry id,
text-part ordinal)`. It applies to duplicate folds with and without cached proof.
A same-identity recurrence refuses accurately rather than buying another rebuild;
a different invocation reusing a call id has a different owning entry and remains
separate.

The guard and pending rebuild record use the existing bounded Pi decision ledger.
Its decoder recognizes the new namespaced kinds, and ordinary cleanup does not
prune these entries merely because a duplicate tag was deleted. Guard claims,
folds and queued rebuild intent occur in the adoption writer transaction. A
pending rebuild survives preparation/fit failures; it is acknowledged only after
the successful managed array and its served identity have been captured. The
spent guard remains after acknowledgement and survives process reload/restart.

## F2: message conflict text

Message and tool errors both use `PiTagIdentityConflictError`, including errors
through a cause chain. The message kind names a message-tag identity conflict,
not storage contention, and does not suggest that an unchanged resend repairs
contradictory identities. The review's F2 `test.failing` is normal and passes.
The storage-busy partner still checks its original retry wording.

The real-host-runner refusal test now supplies a correlated cached body with both
candidate numbers. A missing cache is the newly supported rebuild case, not the
right fixture for an unrecoverable evidence-conflict refusal.

## N1: guard cost and timestamp-less rows

The owner lookup and tag-version/fallback-call-index statements are cached per
database. A session's relevant fallback call-id set is cached against its durable
`tags_version`, with a bounded session cache. Known exact tagger bindings need no
owner probe. A real owner's unrelated call id is skipped before the owner query.

A timestamp-less row can therefore no longer keep a session-wide per-tool probe
path active forever. It guards only its own unresolved call. That call still
fails closed when no exact owner is known: dropping or adopting the row by call id
alone could merge distinct invocations. The cost test leaves such an orphan in
the store, verifies zero owner preparations for ten unrelated passes, then verifies
one cached owner preparation across two legitimate refusals on its own call.

## Tests and changed contracts

`issue-650-recovery.test.ts` covers both tag kinds with cached evidence and without
it. Cached cases assert exact array equality and no identity-rebuild reason/log.
Missing cases assert newest active survivor, one repair log, execute decision,
`tag_identity_repair`, no remaining pending rebuild, unchanged defer bytes, and
application of drop debt on a later execute. Reintroduced conflicts refuse under
the named guard, including after unrelated decision-ledger pruning.

The two issue-640 racing-drop tests now complete the identity fold while keeping
active bytes and queueing the discovered drop. Their original local/sibling
revision-change injection timing is unchanged. The older refuse-on-status-change
assertions were appropriate for the first byte-safe-only implementation, but are
superseded by the review-requested debt mechanism. The unobserved-number refusal
and positive served three-way fold remain intact.

The matrix, twin-call veto, reused-call-id separation and accurate refusal checks
remain in the independent review file. Gates and mutation evidence are recorded
in the delivery and below once complete. All execution uses throwaway roots; no
live stores or configuration are accessed.

## Verification and evidence

- Linux Bun 1.4.2: review + recovery + original tool/message/collision files passed
  60 tests / 412 assertions. The independent review file alone has 16 normal
  passing tests; both former expected-failure findings now pass normally.
- Final isolated review/recovery/timing rerun: 24 tests / 311 assertions passed,
  followed by the corrected priced-reclaim source fence (one test / 12 assertions).
  The source fence now permits the explicit identity-rebuild authorization;
  ordinary reclaim remains gated by the existing priced opportunity.
- Full Linux Pi suite, with a build in the same joined background job, completed:
  1,674 pass / 9 skip / 145 fail across 1,828 tests. The 144 established baseline
  failures remain. The sole additional final-run failure was the embedding-deadline
  timing test, which passed with its two neighboring deadline tests in the isolated
  rerun. This is not a green full-suite gate. An earlier run's const-vs-let source
  fence failure was corrected and separately rerun, not ignored as baseline.
- Root build passed (plugin, Pi and CLI, nine unchanged generated TUI files).
  TypeScript 5.9.3 package checks passed for Pi and plugin, and a temporary
  Pi-derived config typechecked the new recovery tests directly. AFT's final
  diagnostics reported all five scoped production files with zero errors/warnings;
  graph-based analysis remained partial.
- Biome 2.5.1 checks passed for changed production code, review and recovery tests;
  three non-fatal assertions warnings remain in the new test file.
- Four new staged-index mutation controls each failed only their named test while
  the timestamp-less-orphan positive control stayed green: disabling automatic
  rebuilds; propagating a losing drop onto active cached bytes; bypassing the
  durable recurrence guard; and discarding the losing executed drop instead of
  queueing it. Every applied stat was non-empty and every restore-plus-touch stat
  was empty. One interrupted guard-check transport had unknown outcome; only the
  completed rerun is claimed as evidence.

Evidence remains outside build output under
`/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-650/evidence/`:
`resolution-final-suite.*`, `resolution-suite-comparison.json`,
`resolution-typecheck-config.json`, and `resolution-{auto,status,guard,debt}.*`.
No live store/configuration access or new doctor command was used in this work.
