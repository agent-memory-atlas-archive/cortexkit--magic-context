# Issue 650: second independent review (r2)

Reviewed range: master `1c8526be` to tip `5c4a155a` (branch tip of the issue 650
fix, including the rebase onto master's Pi entry-alignment change). This is a
report-only review: no product code was changed. Findings are pinned as
`test.failing` tests in `packages/pi-plugin/src/issue-650-review-r2.test.ts`. Each
has a passing partner test (called "Partner" below) that pins the neighbouring
behaviour that does hold. The alignment
differential script gained an `issue-650` scenario.

The background and the first review are in `issue-650-pi-tool-identity.md`,
`issue-650-pi-message-identity.md`, `issue-650-review.md` and
`issue-650-review-resolution.md`.

## Summary

| # | Severity | Finding | Test (`test.failing`) |
|---|----------|---------|-----------------------|
| 1 | High | In a running Pi process the automatic repair can almost never fire, because a last served array is always in memory. Any failure of the strict cached-proof matcher is then a refusal on every turn until Pi restarts. Three triggers: the agent's own `ctx_reduce` receipt quoting the old number (`Queued: drop §8§.`); any served-text difference such as a stripped reminder; duplicates whose numbers were never served. | `a ctx_reduce result quoting the dropped number must not block the proven 154 survivor`; `reporter state with the ctx_reduce receipt in view should serve rather than refuse every turn`; `a served message whose reminder was stripped must not block its proven survivor`; `a served :pN part whose cached text was transformed must not refuse the whole message`; `never-served duplicates must not refuse just because a served array is in memory` |
| 2 | Medium | A fold on a pass that carries a pending flush signal keeps the signal alive, because the fold's protection reuses `thinkingDropProtected`. The next pass, which the scheduler deferred, then applies the queued drop: a second bust that the logs attribute to `explicit_flush`. | `a fold on a /ctx-flush pass must not make the next scheduler-defer pass bust again` |
| 3 | High (field) | An event message that no lane maps gets an index-bearing `pi-msg-<index>-<ts>-<role>` id. When its index moves, the message guard finds its own earlier fallback row and refuses on every pass. Adoption never re-keys message fallbacks from one fallback id to another. | `an unmapped message whose index shifts must keep its number instead of refusing` |
| 4 | High (field) | Lane switch: a message whose event content differs from its persisted entry is mapped by the positional and anchored lanes, which compare headers. When a pass falls back to the fingerprint lane, the same message is unmapped and the guard refuses on its own real-entry row. | `a switch to the fingerprint lane must not refuse a message the header lanes already mapped` |
| 5 | Low | The once-guard key embeds the owner id. For an unresolved assistant that id is index-bearing, so a recurrence after the index moves is repaired a second time instead of being refused. | `a recurring duplicate on an unresolved owner whose index moved should be refused by the once guard` |
| 6 | Low | The cache-bust classifier has no class for `tag_identity_repair`. An unmaterialized repair pass is reported as `accounted_soft_m1_execute` and a materialized one as a generic `accounted_hard_fold`; the dashboard label table has no entry for the reason. | `an identity-repair pass should get its own cache-bust class` |

Findings 3 and 4 are the most likely explanation of the new Oh My Pi field
report (four message-tag refusals, `lkg_invalidated_reshape`, steady unmapped
slots, 16 of 27 message rows still `pi-msg-*`). See "Field evidence" below.

Every `test.failing` was checked to fail for its stated reason: a throwaway
copy of the file with `test.failing` changed to `test` was run. The exact
failures are quoted per finding. Every partner test passes.

## Finding 1 (High): cached-proof failure becomes a refusal on every turn until restart

**Where.** `adoptPiFallbackTags`'s `plan` (`packages/pi-plugin/src/context-handler.ts:3043-3064`)
offers the newest-number repair only when `readPiServedCachedArray` returns no
messages (`!body?.messages.length`, line 3061). `readPiServedCachedArray`
(`pi-tool-identity.ts`) first reads `getPiLastServedArray`, which is the
in-memory copy of the last array returned to Pi. After the first served pass of
a process, that copy always exists. Pi registers no durable last-known-good (LKG) array backend (only
OpenCode calls `registerLkgPersistence`, `plugin/src/hooks/magic-context/hook.ts:720`),
so the copy disappears only on a process restart.

The cached-proof matchers are deliberately strict:
- `piCachedToolSurvivor` and `piCachedMessageSurvivor` require that exactly one
  of the candidate numbers appears as `§N§` anywhere in the whole array
  (`pi-tool-identity.ts:71`, `pi-message-identity.ts:52`). A quoted old number
  anywhere is a veto.
- `piCachedMessageSurvivor` also requires that the served message, minus its
  leading tag, has the same full fingerprint as the raw entry
  (`pi-message-identity.ts:60`).

When the matcher returns nothing, the served-number ledger is cumulative, so
both numbers count as served. `selectPiTagSurvivor` throws `Conflicting served Pi
… tag numbers`. Nothing in the refused turn changes the in-memory array, so
every following turn refuses identically until Pi restarts. The first turn
after a restart is then repaired with the newest number.

**Trigger 1, the reporter's own state.** The old tag was dropped by the agent.
The real `ctx_reduce` tool returns `Queued: drop §8§.` (`tools/ctx-reduce.ts`,
`formatIds`), and that receipt stays in the served array while it is visible.
The `Queued: drop §8§.` receipt is not a stray quote: it is the normal way a tag becomes dropped.

- Repro (low level): `review 650 r2 finding: a ctx_reduce result quoting the dropped number must not block the proven 154 survivor`.
  Rows: 8 (real owner, dropped) and 154 (`pi-msg-` owner, active). Both are in the
  served ledger. The last served array has `§154§ 1` on the call result plus the
  ctx_reduce receipt. Production options (`allowUnprovenRebuild: true`). Actual:
  `PiTagIdentityConflictError: … Conflicting served Pi tool tag numbers; no byte-safe cached survivor is proven`.
- Repro (real context handler, three passes): `review 650 r2 finding: reporter state with the ctx_reduce receipt in view should serve rather than refuse every turn`.
  Actual: `["refused: identity conflict" ×3]`.
- Partner: `review 650 r2: unquoted reporter state serves the proven 154 on every pass with identical bytes`.
  It passes: 154 stays active, the three passes are byte-identical, and the drop
  stays queued (`[[154],[154],[154]]`). Also `… without a quoted old number, the cached array proves 154 and the fold keeps it active`.

**Trigger 2, transformed served text.** Any Magic Context transform of a served
message (here a stripped `<system-reminder>`; reasoning or caveman rewrites
would do the same) breaks the full-fingerprint comparison.

- `review 650 r2 finding: a served message whose reminder was stripped must not block its proven survivor`.
  Actual: `… message-tag identity conflict: Conflicting served Pi message tag numbers …`.
  Partner: `… a served message identical to its entry apart from the tag proves the survivor`.
- For `:pN` parts, one transformed part refuses the whole pass even when the other part is proven:
  `review 650 r2 finding: a served :pN part whose cached text was transformed must not refuse the whole message`.

**Trigger 3, numbers that were never served.** No served byte is at stake, but
any cached array from earlier in the process blocks the repair. The explicit
`duplicate message identities have no proven served-byte survivor` refusal
(`context-handler.ts`, just before `adoptPiFallbackMessageTag`) then fires on
every turn. This branch renamed master's `r2: three-row unserved ordinal collision
retains the canonical real number` to `… refuses without changing any row`
(`issue-640-review-r2.test.ts`; commits `3d8bddb5b9`, `5cb3a0ad49`). That is a
contract change from fold to refuse. The low-level refusal is intended, but in
production it holds only while a cached array is present.

- `review 650 r2 finding: never-served duplicates must not refuse just because a served array is in memory`.
  Actual: `… duplicate message identities have no proven served-byte survivor …`.
- Partner: `review 650 r2: never-served duplicates with no served array in memory are repaired`.

Existing tests already pin the low-level gate as a refusal: `issue 650 message: both-cached …`
and `… wrong-fingerprint …` in `issue-650-message.test.ts` call `adoptPiFallbackTags`
without `allowUnprovenRebuild`. The finding is not that the gate refuses. It is
that in production, when the gate refuses with an array present, the repair
path is also closed. The resulting state is the original 650 symptom: "refuses
every turn", now with accurate wording, until Pi restarts.

Direction for a fix (not implemented): treat an inconclusive cached array like a
missing one for the repair decision, under the same once-guard. Or let the tool
matcher ignore `§N§` that appears outside text parts beginning with a tag prefix
(the ctx_reduce receipt is the tool result of a different call). Or compare a
message by header and ordinal rather than by full content hash.

## Finding 2 (Medium): a fold on a flush pass causes a second bust on the next deferred pass

**Where.** The fold's protection overrides the survivor's target with
`thinkingDropProtected: true` (`context-handler.ts:7639`). The pending-ops drain
consumes the pending flush signal only if no pending op's target is
`thinkingDropProtected` (`context-handler.ts:7862-7870`, and the same at
8206-8211 when heuristics run). The flag was meant for thinking blocks, which
retry on the next pass. Here it keeps `/ctx-flush` (or any
`signalPiPendingMaterialization`: stable-id scheme cutover, prompt hash change)
alive past the fold pass. The next pass, which the scheduler deferred,
therefore reads and applies pending ops. The survivor is no longer protected,
so the queued drop applies: `§154§ 1` becomes `[dropped §154§]`.

- Repro: `review 650 r2 finding: a fold on a /ctx-flush pass must not make the next scheduler-defer pass bust again`.
  The session is on the current stable-id scheme; the flush is signalled before
  pass 0. Pass 0 serves `§154§ 1` (correct, protected) and leaves `[154]` queued.
  Pass 1 (log: `decision=defer`, then `pending ops WILL APPLY — reason=explicit_flush`)
  serves `[dropped §154§]`. Actual failure: `expect(outcomes[1]).toBe(outcomes[0])` differs at the call result.
- Partner: `review 650 r2: a flush raised after the fold pass applies the queued drop on that flush pass only`.
  The fold happens on a plain pass, the flush arrives before pass 1, the drop rides
  pass 1 only, and pass 2 is identical (`[[154],[],[]]`).
- Same effect without a user flush: when the fold happens on the stable-id
  scheme cutover pass of a legacy session, the cutover's own flush signal
  survives and pass 1 busts. This was observed while building the fixture; the
  log line was `stable-id scheme cutover … forcing execute+materialize`.

This is the one sequence found in which a served status changes outside a
declared bust of its own. The drop rides a pass whose only reason to bust is
the stale signal. The attribution says `explicit_flush` for a flush already
served one pass earlier.

## Finding 3 (High, field): an unmapped message whose index moves is refused on every pass

**Where.** `resolvePiStableId` falls back to `pi-msg-${index}-${ts}-${role}`
(`read-session-pi.ts:142`). Message adoption skips every target id that starts
with `pi-msg-` (`context-handler.ts:3165`), so a message fallback row is never
re-keyed to the message's new fallback id. (Tools were given this re-key in this
change; messages were not.) `guardPiMessageAllocations`
(`context-handler.ts:2812`) then sees a row with the same fingerprint under the
old fallback id and throws.

- Repro: `review 650 r2 finding: an unmapped message whose index shifts must keep its number instead of refusing`.
  Pass 0 has an event-only user message `Context notes: …` at index 0 (it is not a
  branch entry) and serves it as `§1§`. Pass 1 puts an untagged `custom` message
  ahead of it. Actual pass 1: `refused: Magic Context message-tag identity conflict:
  the message's existing entry cannot be safely resolved; no second tag was
  allocated. …`.
- Partner: `review 650 r2: an unmapped message that keeps its index keeps its number across passes`.
- Master (`1c8526be`) had no guard. There the same shift allocates a second
  number for the message, which is the original 650 byte change. The tip turns
  that byte change into a refusal on every pass for as long as the shift
  persists. The automatic repair cannot help, because no duplicate row exists
  to fold.

Index moves happen whenever something ahead of the slot appears or disappears:
a compaction, a custom or system message, an Oh My Pi request-built message.

## Finding 4 (High, field): a lane switch refuses a message the header lanes had mapped

**Where.** The positional lane (`findPiAlignmentMismatch`) and the anchored lane
(`anchorPiEventEntryIds`) identify messages by header (responseId, timestamp,
role, toolCallId), so a message whose event content differs from its entry
still maps to its real id. The anchored lane gives up when anchors are out of
order (`context-handler.ts:2016`), and the pass then uses
`collectMessageEntryIdsByRef` (line 2132), which needs an exact content
fingerprint. The same message is now unmapped and gets a `pi-msg-*` id;
`guardPiMessageAllocations` sees its real-entry row (`m:p0`) with the same
fingerprint and refuses.

- Repro: `review 650 r2 finding: a switch to the fingerprint lane must not refuse a message the header lanes already mapped`.
  Branch: user, custom_message (note), user `m`, assistant, user. The event copy
  of `m` has extra content (`[image: 1 attachment]`). Pass 0 is in projection
  order and maps everything. Pass 1 emits the custom message at the end, so the
  anchors are out of order and the fingerprint lane runs. Actual pass 1:
  `refused: … message-tag identity conflict: the message's existing entry cannot be safely resolved …`.
- Partner: `review 650 r2: a content-rewritten message mapped by header keeps its number while the lane is unchanged`.

This answers whether switching between alignment lanes can create a new
duplicate-identity refusal: it can,
whenever an event copy differs in content from its persisted entry. The
original 650 trigger (an extension rewriting a message) and any host-side
context-time rewrite both qualify.

## Finding 5 (Low): once-guard evasion for unresolved owners

The repair key is `["tool", realOwnerId, callId]` (`context-handler.ts:3304`).
Since this change, `buildPiToolOwnerMap` also maps unresolved owners, so
`realOwnerId` can be `pi-msg-<index>-<ts>-assistant`. After the first repair,
the kept row is re-keyed to the new index when the assistant moves, and a
reintroduced duplicate is folded under a new key with a second automatic
rebuild.

- Repro: `review 650 r2 finding: a recurring duplicate on an unresolved owner whose index moved should be refused by the once guard`
  (actual: `Received function did not throw`; a second rebuild was queued).
- Partner: `review 650 r2: a recurring duplicate on a real-entry owner is refused by the once guard`.

Reaching it needs a writer that reintroduces the duplicate, because the
allocation guard and the tool fallback re-key prevent a fresh one. That is the
same "faulty writer" premise as the resolution's guard test, hence Low.

## Finding 6 (Low): repair passes are not distinctly attributed

`tag_identity_repair` is recorded on the transform decision (`decision=execute`,
`materializeReason=tag_identity_repair`), as the resolution says, and
`normalizeMaterializeReason` accepts it. Downstream, though:
- `classifyCacheBust` (`plugin/scripts/cache-bust-attribution.ts`) has no class
  for it. An unmaterialized repair pass (Pi without m[0]/m[1] injection) becomes
  `accounted_soft_m1_execute` (line 436), which reads as an m1 refresh. A
  materialized one becomes `accounted_hard_fold`.
- The dashboard's `transform_decision_reason_label` (`dashboard/src-tauri/src/db.rs:1686`)
  has no label for it. `host_compaction` is also missing there, so this is a
  pre-existing gap, not new.
- No TypeScript `/ctx-status` path reads `materialize_reason`, so `/ctx-status`
  does not show the repair. The repair is visible only in the decision table,
  the cache-bust analyzer and the session log line.

Repro: `review 650 r2 finding: an identity-repair pass should get its own cache-bust class`
(actual `accounted_soft_m1_execute`). Partner: `review 650 r2: the classifier names an existing materialize reason it knows`.

## Field evidence: Oh My Pi 18.8.7, MC 0.47.0, `pi-rewind` 0.5.0

Nothing here was run against Oh My Pi (OMP); it is not installed. What follows
is inferred from public sources and Magic Context's code; fixtures reproduce
the mechanisms.

Sources:
- OMP `can1357/oh-my-pi` (`packages/coding-agent/src/session/session-context.ts`,
  `packages/agent/src/agent-loop.ts`, `extensibility/extensions/runner.ts`).
- `pi-rewind` 0.5.0 (`github.com/arpagon/pi-rewind`, `src/index.ts`, `src/commands.ts`).

I did not verify which build of the 650 fix MC 0.47.0 contains. The refusal
text in the report should settle that. If it reads "the message's existing
entry cannot be safely resolved", it is the guard from findings 3 and 4.

### (a) Which event shapes leave slots unmapped on this tip

Only `type: "message"` branch entries are indexed for reference and fingerprint
lookup (`addPiBranchEntryToLookup`); custom_message and branch_summary entries
take part only in header alignment. The log `resolved=32/37 … messageEntries=35`
means two slots are not message entries at all (custom, compaction or branch
summary; these are never tagged), and three message slots did not match their
entry's content fingerprint.

| Shape (inferred) | Tagged? | Unmapped on this tip? | Outcome on this tip |
|---|---|---|---|
| OMP request-built messages that are not branch entries (soft tool-requirement reminders, side-channel prompts, execution hints, context notes spliced into the array) | Yes if role user or assistant | Always, in every lane | With a stable timestamp and content: stable while its index is stable; **refusal once its index moves** (finding 3). With a fresh timestamp per request: a new fingerprint and a new number each request, so the served union only grows. That is not a refusal, but it changes bytes mid-array if the message is not at the tail. |
| OMP `custom` messages (custom_message entries, entry timestamp) and system messages | No (unknown role) | Indexed for headers only | Not refused themselves. Their appearing, disappearing or reordering moves later indexes (finding 3) and can put anchors out of order, switching to the fingerprint lane (finding 4). |
| Persisted messages whose event copy differs in content from the entry (any context-time rewrite; the three non-matching message entries in the log) | Yes | Mapped by the header lanes, unmapped by the fingerprint lane | **Refusal whenever the pass falls to the fingerprint lane** (finding 4). Also refused when the copy is unmapped and its index moves (finding 3). |
| `pi-rewind` checkpoint | — | No effect | It registers no `context` handler and appends no session entries; checkpoints are git refs. |
| `pi-rewind` `/rewind` (`ctx.navigateTree(target, { summarize: true })`) | Branch summary is not tagged | Messages before the branch point keep their ids and indexes | Expected stable: earlier unmapped slots do not move, and the abandoned branch's rows stop being visible. A re-sent identical prompt has a new timestamp, so no fingerprint twin arises. The default alignment differential exercises a branch summary: no refusal, `collect=0`. Not exercised: a rewind that lands right after an unmapped request-built message. |

Repeated repairs: none found for message slots. The repair is a fold over
duplicate rows, and both refusal paths above come from the allocation guard,
which runs before any fold could happen, so they are refusals, not loops. For
tools, a fallback-to-fallback re-key exists and drifting unresolved assistants
stay stable (existing test `issue 650: drifting unresolved fallback index adopts the served number`).

### (b) Many served numbers per message (`:pN` parts all served)

The survivor and repair rules handle each part independently (repair key
`["message", "<entry>:pN"]`):
- With a cached array proving each part: `review 650 r2: every served :pN part with a cached array folds to its served number without a rebuild`. It passes.
- With no cached array (first pass after a restart): `review 650 r2: every served :pN part without a cached array is repaired once, per part, and then stays settled`.
  It passes: one rebuild per part, newest numbers kept, nothing new on the next adoption.
- With a cached array where any part's served text differs from the raw part: the
  whole pass refuses until restart (finding 1, `… a served :pN part whose cached text was transformed must not refuse the whole message`).

A growing served union does not by itself cause a refusal. A union of 44
numbers for 27 rows is consistent with fresh-timestamp request-built messages,
or with re-allocation after index moves on builds without the guard. The rules
refuse forever only in the finding 1, 3 and 4 shapes.

## Checked and held (no finding)

- The repair does not fire when the cached array proves a survivor (partner tests above, and `issue-650-recovery` cached cases).
- A repair pass is a declared rebuild: `bustedThisPass`, `decision=execute`,
  `materializeReason=tag_identity_repair` and one session log line. Its m0/m1
  prefix is discarded so it rematerializes.
- A real-owner recurrence is refused by the once-guard. The guard survives
  ordinary ledger pruning, because `freezePiContentDecision` keeps both new kinds.
- Without a pending flush, the queued drop stays queued across scheduler-defer
  passes and applies on the next pass that busts for its own reason (partner tests in finding 2).
- Identity conflicts rethrow before the degraded and raw fallback path
  (`context-handler.ts`, `findPiTagIdentityConflict` in the pass catch), so no
  raw history is sent on refusal.
- Alignment differential with a 650 conflict (`MC_ALIGN_SCENARIO=issue-650`, added):
  a duplicate tool row seeded after a simulated restart is repaired once (7 → 500)
  and then stays stable through a `context_edit` omission, a compaction and
  appends, in both event shapes. There were no refusals and `collect=0` on every pass.
  The repair necessarily changes the call result's number on that pass.

## Suite runs (Linux, Bun 1.4.2, throwaway HOME, `OPENCODE_DB` unset)

Raw output and the scripts used are kept outside the repository in
`/private/tmp/magic-context-issue-650-r2-evidence/` (`suites-master-vs-tip.txt`,
`suites-run2-tip-timing-flake.txt`, `run-suites.sh`, `junit-compare.ts`).

Method: one remote job ran the master tree (`git archive 1c8526be`, built with
`bun run build`) and this tip, each with `BUN_JSC_useOMGJIT=0 bun test
--parallel=4 --timeout 30000 --reporter=junit` in `packages/pi-plugin`. The two
JUnit reports were compared per `file::describe::test name`. The registry was
unreachable from the runner, so master reused the tip's `node_modules`; no
`package.json` or `bun.lock` changed between the two commits.

- **Full Pi suite.** Master: 1,804 tests, 1,794 pass, 10 skip, 0 fail. Tip
  (including this review's file): 1,880 tests, 1,870 pass, 10 skip, 0 fail.
  Per test name: 1,800 identical outcomes and 77 tests new at the tip. The only
  test present on both sides with a different outcome or name is the renamed 640 test (finding 1, trigger 3). An earlier
  tip run in the same session had one failure, `Pi aborts slow embeddings at the
  deadline and replays byte-identical skip on retry` (3.4 s). It passed in the
  other two tip runs; the resolution notes the same timing flake.
- **Replay and byte-identity subset.** `context-handler-lkg`, `fold-content-replay`,
  `issue-485-replay-gate`, `native-replay-pi`, `native-replay-state-pi`,
  `overwall-upgrade-replay`, `pi-lkg*`, `reasoning-replay-pi`,
  `served-array-ledger`, `served-collision`, `served-identity-refusal`,
  `auto-search-bounded`, `context-handler.test`, `ctx-reduce-nudge-pi`,
  `inject-compartments-pi*`, `provider-error-recovery-pi`, `reminder-strip-pi`,
  `strip-tag-prefix` and `transcript-pi`: 472 tests, 470 pass and 2 skip on both
  sides. All 472 outcomes are identical by name.
- **Alignment differential** (`MC_ALIGN_DIFF=1`, `pi087` and `systems` shapes):
  the `default` and `kept-duplicates` scenarios print identical hash, tag and
  lane lines on master and tip (16 lines per scenario on each side). Sessions without conflicts
  therefore serve identical bytes through the custom-message, branch-summary,
  `context_edit` omission, duplicate-user and compaction lanes. The new
  `issue-650` scenario (tip only) passes as described above.

## Could not check

- Real OMP 18.8.7 or `pi-rewind` behaviour. Everything in the field section is
  inferred from source; the fixtures reproduce mechanisms, not OMP's exact
  arrays. Which MC 0.47.0 code produced the four refusals is unknown.
- Identical-twin pairing beyond the existing `issue-650-identical-pair` tests:
  more than two twins, twins across a branch jump, served versus unserved
  newest pairs. Noted from code: when `piPairingKeepsServedNumbers` rejects a
  pairing, the result is a guard refusal (existing test `refuses rather than move
  a newest pair the model never saw`). The automatic repair cannot reach that
  refusal either, so it lasts while the twins are visible.
- The fit, 95% refusal and LKG rules on a repair pass were checked only by
  reading code. A repair pass under pressure was not exercised.
- Session clone, fork or `/tree` copies of the guard; Pi `/reload`. The guard
  lives in `session_meta` and is durable across restart; whether a fork copies
  `session_meta` decisions was not checked.
- A full decision ledger (4096 entries): guard claims then fail and the pass
  refuses ("identity repair guard could not be persisted"). Guard entries are
  never pruned and share the cap with reminder-strip decisions. Not exercised.
