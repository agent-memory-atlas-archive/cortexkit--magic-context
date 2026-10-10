# Index-only canonical ordinals and tag-owner summary: independent r2 review

## Scope and conclusion

Reviewed `d2e024c109d14cfddf2da01721b83e4446ee80f6` against `6bc65dcc`, the
whole-prefix ordinal oracle, together with `packages/plugin/scripts/perf-audit/STALL-COST.md`,
`docs/reports/oc-stall-fixes-review.md`, and the existing `oc-stall-*review*` tests.
This delivery changes **only new review tests, their controlled worker fixture,
and this report**. No product code or existing test claim is changed.

**The normal compaction/append path passed the extended differential and the
served-byte fixture, but that is not a general correctness proof.** There is a
new concurrent rowid-reuse hole that returns a wrong ordinal using ordinary
legacy OpenCode insert/delete writes. Preparation also incorrectly reports
`warm` to a second awaiting connection without installing its candidates. The
tag cache's foreign-write residual is wider than “count and max unchanged”:
a foreign backfill accompanying an append is missed even when both change.
Session reassignment and explicit-id tag replacement have additional witnesses,
but no ordinary legacy OpenCode writer for the former or routine tag writer for
the latter was demonstrated.

`test.failing` witnesses show as **pass** when Bun observes their assertion
failure. They are not fixes. Each has a passing repair/control; strict ordinary-test
probes below verify the actual failing assertion rather than a setup exception.

## Findings

### P1 — rowid reuse after anchor validation can permanently lose a summary

Location (package-relative): `src/hooks/magic-context/read-session-raw.ts:1091-1105,
1192-1228, 1274-1305`.

A cold candidate set is not needed. Warm it with `target@20` and `top@30`, where
`top` has the highest rowid. During the next count:

1. `survivingAnchor` verifies the old `top` and returns its rowid.
2. A different connection deletes `top`, inserts a *new* `summary:true` row at
   time 1, reusing the deleted rowid, and then finishes it with `stop`.
3. `SUMMARY_SCAN_AFTER_SQL` uses `rowid > oldFloor`; the reused row is not read
   as a candidate. However its anchor arm sees the replacement summary and
   adopts it as the **new** highest anchor.
4. The canonical count checks the new anchor's ID, which matches. Neither the
   known-candidate branch nor the `rowid > newFloor` branch subtracts the summary.

`target` is returned as ordinal **2**, versus the old whole-prefix result **1**.
A later count still uses the damaged candidate set. Store stamps prevent reuse
of an unstable watermark; they do not repair this candidate-discovery race. The
floor check protects the later scan-to-count window, not the earlier
anchor-validation-to-scan window.

Witness: `stall r2 ordinal witnesses > rowid reuse between anchor validation and
incremental scan must not lose a finished summary`. Passing control:
`rowid reuse race: forgetting candidates restores the whole-prefix result`.
The test intercepts the actual incremental SQL preparation, commits through a
real second WAL connection, and asserts rowid reuse. It does not mutate the
production query or introduce an ordinary-row-to-summary in-place edit.

This interleaving uses writer shapes present in legacy OpenCode: message removal
and insertion of an initially flagged summary followed by finishing it. It is
not a claim that a single synchronous writer interleaves itself, or that this
race was reproduced with a live OpenCode host.

### P2 — shared preparation installs only the first caller's connection

Location: `src/hooks/magic-context/raw-ordinal-warmup.ts:198-200, 206-238`.

`inFlight` is keyed by **path + session**, whereas candidate sets are keyed by
**Database object + session**. Two connections await the same promise. Its
closure installs the scan only on the first connection, yet both receive
`warm`. The second is still cold and its next synchronous count performs a
full in-thread scan without a worker failure.

Witness: `coalesced warm-up must install candidates on every awaiting connection`.
It observes `["warm", "warm"]`, then `isRawSessionSummaryWarm(second) === false`.
Control: `coalesced warm-up: a second prepare on the other connection actually
warms it`. The small fixture forces the worker branch with `inThreadMaxRows:0`;
the same branch is the default for sessions above 2,000 rows. No claim is made
that the normal v1 singleton reader always produces two simultaneous handles.
A reader replacement while a worker is outstanding is an important review case.

### P2 — a foreign append-shaped commit can also rewrite old estimates

Location: `src/features/magic-context/storage-tags.ts:884-904, 935-964`.

The shape predicate proves only the net row count and highest ID, not that an
append-shaped commit consisted exclusively of appends. Warm two message tags,
then on another connection backfill the old tag's reasoning count from 40 to
1,000 and append tag 3. The cache observes the appended owner, so the foreign
commit was reached, but returns **40**, not the committed **1,000**, for the old
owner. **Both count and maximum ID increased**; this is outside the narrow
unchanged-count/max description in the brief. The source report's broader list
of foreign identity rewrites should not be mistaken for a sound shape proof.

Witness: `a foreign append plus reasoning backfill must refresh existing
estimates even when count and max both grow`. Control: `append plus reasoning
backfill: the same-process identity generation refreshes estimates`.

This still requires another process to touch a served session's identity/count
inputs. The assertion that only one process can do that is not enforced by the
inspected Pi startup/adoption path: Pi opens shared `context.db`; adoption uses
the current session ID and SQLite revision/`BEGIN IMMEDIATE` coordination, not
a session ownership lease (`packages/pi-plugin/src/index.ts:1170-1182, 1851-1865,
1891-1894`; `context-handler.ts:2709-2723, 2851-2909, 7103-7167`). Adoption normally
runs in the serving process, but a second serving process can legitimately
operate on that same session. No two live Pi hosts were launched to demonstrate
that deployment; this review does not assert a background adoption daemon exists.

### Supported-contract probes, not demonstrated routine writer regressions

- **Finished summary moved into a warm destination:** candidate discovery misses
  a summary with old rowid when `session_id` changes from another session. Both
  point APIs return **2 rather than 1**; forgetting the destination fixes it.
  Witness: `a finished summary moved into an already warm session must be excluded`.
  Legacy `MessageUpdated` does *not* change session ID on conflict, and a native
  session location move updates only the session table. Treat this as a wider
  database-mutation contract limitation, not evidence that the native move UI
  currently changes a message's session ID.
- **Foreign delete + explicit-id reinsertion below maximum:** replacing tag 1
  with another owner under the same row ID preserves count/max and retains the
  deleted owner. Witness: `foreign delete and explicit-id reinsertion below max
  must not retain a deleted owner`; reopening is its control. Unlike an in-place
  re-key, this is a delete/insert pair. The production comment already notes this
  cancellation case (`storage-tags.ts:765-768`). No routine writer inserting
  `tags.id` explicitly was found; this is not promoted to a new production-path
  defect.

## Differential and writer-pattern evidence

The requested external repository's **tag** `v1.18.35` resolves to
`53d1eabb61e21162157817bf677da0a4ad3332e3`. Its checkout HEAD is different; the
legacy files were read from the tag, not from the current working tree.

- `packages/opencode/src/session/compaction.ts:393-424` creates an assistant with
  `summary:true` and no `finish`, publishes it via `updateMessage`, then creates
  the processor. The old summary predicate excludes it only after `finish:stop`.
- `packages/core/src/session/projector.ts:260-272` inserts message ID, session ID,
  creation time and data, but `ON CONFLICT(id)` updates **data only**. It preserves
  rowid/session/time. `:274-291` deletes the message on legacy `MessageRemoved`.
- Legacy `packages/opencode/src/session/revert.ts:101-123` removes the suffix using
  `removeMessage`; a part revert retains the boundary message and removes parts.
  This is distinct from the newer `SessionMessageTable` revert projector.
- `packages/core/src/session/projector.ts:242-259` handles session location moves
  by changing session location fields, not message membership, and session
  deletion by deleting the session. Timestamp ties are legal; timestamp/session
  column changes below are deliberate wider-contract stress cases, not normal
  legacy upsert effects.

`oc-stall-r2-ordinal-review.test.ts` runs **six seeds x 1,000 steps per variant**
(seeds `1, 7, 42, 650, 0x5d0ee2b3, 0xffffffff`), using two actual WAL connections
and independent old SQL. The ten operation classes each execute 600 times:
ordinary inserts, flagged-summary inserts, finishing summaries, prefix deletes,
time moves/ties, deleting/reusing the highest rowid, deleting/reinserting a
summary with the same ID, suffix reverts, session moves (or another time move in
the legacy-shaped variant), and a scan installed after an intervening append.
Both point APIs and the total indexed count are compared for both sessions after
every step. Permanent targets survive the deletes.

- The 6,000-step variant without message-session reassignment passes.
- The 6,000-step variant including reassignment is an expected failure. First
  recorded mismatch: seed 1, step 38, `ses-r2-a`, old **13**, both point APIs and
  indexed count **14**.
- The identical 6,000-step variant invalidating destination candidates on moves
  passes. Total differential exercise: **18,000 steps**.
- A separate named test holds a real WAL read snapshot, commits a reused-rowid
  summary on the writer **before the scanner's query returns**, installs the
  older scan after releasing the snapshot, and matches the old ordinal. The
  controlled worker test also pauses after snapshot capture while a second
  connection writes/finishes summaries for **two sessions** before replying.
  Neither passing scan race covers the P1 incremental-anchor race above.

## Warm-up lifecycle and remaining in-thread work

The controlled worker covers never accepting, accepting but never answering,
holding a result beyond its deadline, delayed valid snapshots, superseded epochs,
two simultaneous sessions, and explicit stop. Timeouts return `failed` without
an in-thread scan and back off; a forgotten epoch yields `superseded` without
failure backoff, allowing immediate retry. Stop resolves both awaiters as failed.
The existing transform test separately verifies stages wait for preparation and
still run after a false result (`transform-raw-ordinal-warmup.test.ts`).

Default acceptance timeout is 2 seconds; result timeout is **10 minutes**;
backoff is 5 minutes. Thus an accepted silent worker can hold a transform request
for ten minutes, although it does not block the main thread. Tests shorten those
timeouts; they do not establish a latency SLA.

Stopping is wired to process-exit abort (`raw-ordinal-warmup.ts:105-110`,
`shared/exit-abort-registry.ts:15-38`). No runtime plugin-unload call to the stop
function was found. The inspected v2 dispose path releases providers and closes
its reader pool but does not stop these workers (`src/v2/hooks/context.ts:2306-2321`).
The explicit-stop tests prove the stop API, **not unload wiring**. A pending
worker need not end at unload before its deadline/process exit.

“No in-thread scan outside worker failure” is too strong:

- small sessions (up to 2,000) and in-memory stores intentionally scan locally;
- the second-connection preparation witness above permits a cold synchronous count;
- a successful prepare is not a durable lease on the anchors: deleting all
  remembered anchors afterward forces `summaryCandidatesOf` to rescan. The named
  `a successful warm-up does not prevent an in-thread rescan after all remembered
  anchors are deleted` test observes one full scan with zero warm-up failures;
- unsupported rowid/JSON1 stores retain the old JSON count; the first reconciliation
  page's JSON-filtered OFFSET is another documented serving-thread read.

An OpenCode 2-style registered provider passes preparation without any source
read or SQLite worker, directly tested through `prepareRawSessionOrdinals`.
The v2 transform uses that default preparation seam. Pi uses its own context
handler, not `createTransform`, and registers raw-message providers
(`packages/pi-plugin/src/context-handler.ts:3318, 6006`); the shared preparation
function is a no-op for those providers. This is source/provider-contract
coverage, **not packaged OpenCode 2 or Pi host integration**. The current
`build:v2` actually includes the worker entry; hosts with a registered provider
do not need it for this path.

## Foreign tag writer audit

| Area | Inspected result and boundary |
|---|---|
| Tool-owner backfill | Store-open backfill sets previously NULL owners; remembered unowned-row rereads cover this (`storage-db.ts:1033-1061`, `tool-owner-backfill.ts:401-474`, `storage-tags.ts:907-915`). Existing foreign-owner test passes. |
| CLI doctor / migrate-session | No direct production tag SQL matches in `packages/cli/src`. `migrate-session.ts:286-436` changes session location/project/meta/embeddings. Repair salvages a replacement file and invokes initialization/migrations (`doctor-repair-db.ts:396-420, 459-469`), not a routine online re-key. Delegated historical migrations were not exhaustively audited. |
| Dashboard src-tauri | Searches of `packages/dashboard/src-tauri/src` found no direct `tags`/`mc_tags` SQL writer; `db.rs` resolves both context/store paths. This is not proof about arbitrary dependency-generated SQL. |
| ck-mc / mc-store | Runtime tag allocation/update/lineage copy inspected in `crates/mc-store/src/lib.rs:9415-9506, 10976-11010, 12294-12301` writes `store.db.mc_tags`, not the cached `context.db.tags`. Move inventory explicitly distinguishes the two (`move_inventory.rs:1754-1783, 1979-1998`); that inventory alone is not an executed writer. The installed external binary was not run or inspected. |
| Clone | `scripts/clone-session.ts:1151-1162, 1451-1460` delegates to `storage-clone.ts:545-604`: destination tags preserve tag numbers but receive generated IDs, not explicit `tags.id`. Copying into a new destination is append-shaped. Dependent source/pending tag references are separately copied. |
| Recomp | Inspected promotion transaction replaces compartments/facts/staging, not tag identities (`compartment-runner-recomp.ts:103-143`); it awaits prepare before boundary reads (`:172-175`). This is not an exhaustive closure of every helper. |
| Pi issue 650 adoption | A transform-time re-key of fallback IDs, guarded by SQLite revisions/transactions. It normally serves the same process's session but has no inspected single-process ownership enforcement; concurrent serving processes invalidate the universal exclusivity claim. |

No additional *routine explicit-ID* foreign replacement writer was established.
Do not turn these bounded negative searches into an exhaustive no-other-writer
proof. The cache still depends on deployment-level writer assumptions.

## Served bytes

The new `oc-stall-r2-served-review.test.ts` runs the real TS `createTransform` on
25 messages (12 user/assistant turns plus the final request), timestamp ties,
reasoning blocks, completed read tools with multiline output, and a finished
summary in the raw store. It captures full `JSON.stringify(messages)` bytes,
not just ordinals or a replay proxy. Goldens were generated using the **complete
plugin source at 6bc65dcc** extracted inside this worktree; the current fixture
was copied into that tree, not the current transform/cache implementation.

Four passes match in both trees: initial, defer, forced rebuilding after a tag's
persisted drop, and defer replay. Defer must equal initial; rebuild must differ
and remove the selected tool output; replay must equal rebuild.

| Pass | UTF-8 bytes | SHA-256 of full served JSON |
|---|---:|---|
| Initial / defer | 60,568 | `456512031b061875b93ba4c291eacbd08be38e42f92f2d637e588499741d093f` |
| Rebuild / replay | 57,850 | `04a8af262a83d0363111a0db50c38304cd4b5486f030d2c0a86146270cde9333` |

Both ancestor and tip passed the golden assertion. These are a host-free realistic
small fixture, not a 39-GB-store measurement or universal provider-wire proof.
No OpenCode/Pi host, daemon, or live store/config was opened; consequently there
is no host PID or claimed `lsof` host-isolation capture. Unit gates use the
repository's fixture/storage/config isolation preload and throwaway environment
roots; the full-suite command leaves OPENCODE_DB unset so each existing fixture
can choose its own database instead of overriding them all with one nonexistent
file. No live-store override or local-test fallback was used.

## Verification

All executable gates ran on Linux (Bun **1.4.2 / 744846f84**); no local fallback.

1. **Full plugin gate:** launched in the background with `runon:"linux,8c"` and
   awaited with `bash_watch`: `env -u OPENCODE_DB bun run test`. Frozen install
   checked **1,010 installs / 1,251 packages**, no changes. Result: **7,597 pass,
   19 skip, 12 fail; 7,628 tests / 762 files / 223,394 expectations**. The final
   additional anchor-loss observation test was added afterward and is covered
   by the focused final gate below; the full suite is not represented as green.
2. **Full-suite failures:** nine packaged/built worker tests report missing
   `dist/auto-search-worker.js` or packed worker entries; one WASM fixture cannot
   resolve `onnxruntime-web/webgpu`. These reproduce on the extracted ancestor.
   The Windows spawn-policy test reports existing
   `packages/plugin/src/shared/sqlite.test.ts:34 spawnSync`; after supplying its
   Pi/CLI source-scan inputs, the ancestor reports the identical violation.
   The writer diagnostic's timing assertion observed `hold_ms=325` against `<250`
   under the parallel suite, but all five diagnostic tests pass when rerun alone
   on both ancestor and tip. No source involved in these failures was changed.
   The tip four-file rerun has **5 pass, 2 skip, 11 fail / 18 tests**; the corrected
   ancestor Windows/WASM rerun has **0 pass, 2 fail / 2 tests**, with matching
   causes. The initial incomplete ancestor export's missing scripts/source dirs
   are not claimed as baseline parity evidence.
3. An initial full-suite attempt with a globally set throwaway OPENCODE_DB
   produced **7,393 pass, 19 skip, 216 fail** because existing fixtures route via
   their own XDG paths. It was discarded as an environment-routing error and
   rerun using the canonical test preload and unset override. No live store
   routing was used to repair that run.
4. **Strict expected-failure probes:** staged the live review files, observed an
   empty unstaged `git diff --stat`, changed the six `test.failing` registrations
   to ordinary `test` under the exact marker `NON-VACUITY BREAK`, and observed
   `3 files changed, 9 insertions(+), 6 deletions(-)`. Each filtered successful
   probe reached **exactly its named assertion failure**: ordinal 2 vs 1, moved
   summary 2 vs 1, randomized seed 1/step 38 (14 vs 13), second connection cold
   after warm, estimate 40 vs 1,000, and retained deleted owner 1. The two focused
   ordinal controls passed in the same strict runs; other controls pass in the
   final normal gate. Two initial anchored filters matched zero tests and were
   discarded/replaced with matching filters; they are not failure evidence.
   Restored via `git checkout -- <the three staged paths> && touch <paths>` and
   captured an empty unstaged diff. No break marker is delivered.
5. **Final focused gate:** `env -u OPENCODE_DB BUN_JSC_useOMGJIT=0 bun test
   --timeout 30000`, selecting all four new review `.test.ts` files plus
   `read-session-raw-indexed-ordinal`, `raw-ordinal-warmup`,
   `transform-raw-ordinal-warmup`, `oc-stall-ordinal-review`,
   `oc-stall-cache-review`, `storage-tag-owner-summary`: **66 pass, 0 fail /
   10 files / 4,083 expectations**. Six of those are new expected-failure
   witnesses; all passing controls and the final additional lifecycle tests
   executed. The differential alone exercises 18,000 steps.
6. **Ancestor/tip served JSON capture:** ordinary fixture/golden tests on both
   trees pass; the combined ancestor capture, tip capture and new tag witnesses
   run has **6 pass, 0 fail / 3 files / 30 expectations**. Earlier fixture setup
   trials did not rebuild a queued drop; the delivered fixture instead changes
   persisted drop status and proves that the rebuilding output actually differs.
7. **TypeScript 5.9.3:** `bun run typecheck` passed its three project checks.
   Because the regular config excludes tests, a temporary
   `tsconfig.oc-stall-r2-review.json` explicitly includes the five new TS files
   and clears that exclusion; `./node_modules/.bin/tsc --noEmit -p
   tsconfig.oc-stall-r2-review.json` passed after fixture type corrections and
   again after the final edits. The temporary config is not delivered.
8. **Biome 2.5.1:** repository-local formatter touched only the five new TS files;
   the final `./node_modules/.bin/biome format <five files>` check reports
   **5 files, no fixes applied**. AFT scoped inspection is PARTIAL because the
   checkout call graph/test diagnostic coverage is unavailable, not a clean
   whole-package claim. The one worker-fixture non-null warning observed during
   inspection was replaced with an explicit parent-port check.
9. **Skipped:** new build/package-host/performance gates, since only report/test
   files changed. The supplied worktree preparation build is not substituted for
   a remote packaged-host test. No manifests/lockfiles changed, no push, and no
   live OpenCode, Pi, CK daemon, user configuration or production store access.
10. **Comment-review tooling gap:** sidekick comment-review requests were made
    before committing, but returned a truncated answer and then refused
    path/selection extraction (zero files reviewed). No clean automated comment
    review is claimed; the short inline explanations were inspected directly.
    Source/writer research did return usable cited findings as described above.
