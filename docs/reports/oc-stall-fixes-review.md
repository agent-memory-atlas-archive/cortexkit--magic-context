# OpenCode serving-thread stall changes: independent review

## Scope and verdict

Reviewed `9d26c87081a9925217fa09698ce08e7a092e1f4d` through
`5d0ee2b38248e919e97dd83599d80cfc0644d7cf`, starting with
`packages/plugin/scripts/perf-audit/STALL-COST.md`. This is a **report-only**
review: no production implementation or existing test was changed. New defects
are recorded with `test.failing` and passing partners. Those tests appearing as
“pass” means Bun observed their expected assertion failures, not that the defect
has been fixed.

**Do not treat the fixture's equality checks as general parity proof.** The
append-only optimization preserves the demonstrated fast path but can return
wrong canonical ordinals after a mutation behind a surviving watermark. The
shared SQLite wrapper also misses two supported same-connection write forms,
producing a stale reasoning cutoff. The explicit-search worker has no deadline
for an alive worker that never responds. Ordinary replay/byte-identity suites
are unchanged by test name; these adversarial cases are outside their fixtures.

No live OpenCode/context/store database or user configuration was opened. The
tests use `:memory:` or registered temporary fixture directories, the plugin's
storage/config isolation preload, and `env -u OPENCODE_DB`. The ancestor was
extracted with `git archive` inside the review worktree; no parent checkout or
host was used.

## Findings

### High / P1 — a surviving ordinal watermark does not notice prefix mutations

**Location:** `src/hooks/magic-context/read-session-raw.ts`,
`trustedOrdinalWatermark`, `canonicalOrdinalOf` (paths here are relative to
`packages/plugin`). Trust checks the remembered row's existence, creation time,
summary flag and an event-driven removal epoch, not changes to earlier rows.
Unlike the tag cache, this cache does not check SQLite `data_version`. Both the
point-message reader and ordinal-only reader use this same anchor.

**Consequence:** indexing can store a wrong history reference; the paged
`ctx_expand`/historian reader and CK ingress's ordinal-page walk can then refer
to a different message. This is not merely a stale performance statistic.

Small deterministic reproductions warm `b-watermark` at ordinal 2 in
`a@10, b-watermark@20, c@30`, then look up `c` after the following changes:

| Expected-failure test (under `stall review ordinal differential`) | Change | Fresh old count | Observed |
|---|---|---:|---:|
| `delete-prefix: a surviving watermark must match the old count` | Delete `a` without delivering a removal invalidation | 2 | 3 |
| `move-prefix: a surviving watermark must match the old count` | Move `a.time_created` to 50 | 2 | 3 |
| `insert-before-tie: a surviving watermark must match the old count` | Insert `b-before@20`, sorting before the watermark | 4 | 3 |
| `finish-summary: a surviving watermark must match the old count` | Change `a` from `summary:true, finish:length` to `finish:stop` | 2 | 3 |

Each has a passing partner named `<change>: explicit invalidation restores the
old count`, using `forgetRawSessionOrdinalWatermark` after the identical write.
The summary case starts with a *finished* ordinal-bearing summary, so it bypasses
the protection against anchoring past an unfinished streaming summary.

A separate file-backed, two-connection reproduction warms the reader at `b`,
then commits `concurrent-before@15` and `c@30` through the other connection.
`external-prefix-write: another indexer's commit must invalidate the watermark`
returns canonical ordinal 3 for `c` instead of 4: all four rows
(`a`, `concurrent-before`, `b`, `c`) now precede or equal that target. Its partner,
`external-prefix-write: reopening the reader restores canonical ordinals`,
returns 4. This is a deterministic concurrent-writer interleaving, not a timing
race. Watermarks are connection-local `WeakMap` entries: a real restart loses
them and repairs this case; a surviving process keeps the stale anchor.

`randomized differential: mixed prefix writes must preserve the old
whole-session count` compares both point APIs to a literal copy of the old
whole-session SQL. It uses seed `0x5d0ee2b3`, 32 initial messages with timestamp
ties, a tail, and 80 alternating insert/delete/time-edit/summary mutations.
The first insertion already produces `tail: expected=34, point=33,
ordinalOnly=33`. It also probes backwards from the tail. Its passing partner,
`randomized differential: invalidating each write matches the old whole-session
count`, runs the same sequence and agrees throughout.

**Boundary of the finding:** ordinary suffix reverts that delete the watermark,
handled `message.removed` events, two sessions, static equal timestamps and
backdated *excluded* compaction markers pass. These are separately controlled by
`two sessions, suffix revert and summary markers keep canonical ordinals` and
the delivered watermark suite. The production comment assumes increasing
`(time_created,id)` appends and lifecycle delivery. This review deliberately
tests the broader contract in the brief; it does not claim an ordinary OpenCode
append always violates that assumption or that host restarts preserve this map.
Timestamp edits and finished-summary rewrites were exercised as database edits,
not demonstrated through a live host UI.

### Medium / P2 — `iterate()` writes bypass tag-identity invalidation

**Location:** `src/shared/sqlite.ts`, `installTransactionRouting`, and
`src/features/magic-context/storage-tags.ts`, `readTagOwnerSummary`.
The wrapper wraps prepared statement `run`, `get`, and `all`, but not `iterate`.
SQLite's `data_version` does not change for writes through the same connection,
so neither of the cached projection's two invalidation signals changes.

**Reproduction:** prime the cached owner/estimate projection for two assistants
with tags 5 and 10. Execute and consume:

```sql
UPDATE tags SET tag_number = 6, reasoning_token_count = 1000
WHERE session_id = ? AND message_id = 'old' RETURNING tag_number
```

through `statement.iterate()`. The returned row is `{tag_number:6}` and a direct
SQL read confirms the committed identity/count. Nevertheless
`projectOpencodeReasoningBudgetCutoff(..., budget=100, watermark=0, proseRatio=1)`
still returns **5 instead of 6**. The cutoff is the highest tag number whose
old reasoning falls outside the retained budget. In this fixture the newest
assistant's exempt reasoning consumes the entire 100-token budget, so the older
assistant must be outside it; its tag changed from 5 to 6. A stale cutoff of 5
can therefore preserve reasoning that a fresh projection would remove.

- Expected-failure test: `iterate write: consuming UPDATE RETURNING must refresh
  the reasoning cutoff`.
- Passing partner: `iterate write: executing the same UPDATE RETURNING with all
  refreshes the cutoff`.
- Both run as ordinary passing tests on the ancestor's full-read implementation.

No current production tag writer using `iterate()` was found. This is a
regression in the supported SQLite surface, not an assertion that `ctx_reduce`
currently calls this method. It is rated medium rather than high because an
in-repository production trigger for this supported API hole was not found.

### Medium / P2 — mixed scalar/tuple SQL can be misclassified as status-only

**Location:** `src/shared/sqlite.ts`, `mayChangeTagIdentity`. The assignment regex
extracts `status` from the following valid SQLite statement but skips the tuple;
because at least one harmless scalar assignment was found, the conservative
empty-assignment fallback does not apply:

```sql
UPDATE tags SET status = 'dropped',
                (tag_number, reasoning_token_count) = (6, 1000)
WHERE session_id = ? AND message_id = 'old'
```

Executing it with the wrapped `run()` changes the stored row but leaves the same
reasoning cutoff at **5 instead of 6**. Rewriting only the SQL into equivalent
scalar assignments makes the projection return 6.

- Expected-failure test: `mixed tuple write: status plus identity assignments
  must refresh the reasoning cutoff`.
- Passing partner: `mixed tuple write: scalar identity assignments refresh the
  reasoning cutoff`.
- Both pass as ordinary tests on the ancestor.

A tuple-only assignment is conservatively invalidating; it is the mixed form
that escapes. No current production writer with this syntax was found. As with
`iterate()`, this exposes the invalidation abstraction's limits rather than a
proven current `ctx_reduce`/Pi call site.

### Medium / P2 — an alive, nonresponding explicit-search worker never falls back

**Location:** `src/hooks/magic-context/auto-search-worker-client.ts`,
`searchMessageHistoryOffThread`. The promise resolves only on a recognized reply,
error, or exit. There is no timer/cancellation bound. A worker that remains alive
without one of those events leaves `ctx_search` awaiting it indefinitely;
`unifiedSearch` cannot reach its in-process fallback.

- Expected-failure test: `silent worker: the message lane must resolve to fallback
  within a bounded wait`.
- Passing partner: `silent worker: a reported worker error falls back with
  identical results and order`.

The injected worker entry has no database access. It deliberately sends no
recognized reply, stays alive for two seconds, then exits so the test cannot
orphan a worker. At the 500 ms sentinel the promise is still pending. **500 ms
is a test sentinel, not a claimed product latency SLA**; the source-level issue
is the absence of any deadline. The partner uses an explicit error reply and
compares a nonempty result array, including order, with in-process search.

## Checks that did not expose a regression

### Malformed rows and canonical ordinal parity

The point lookup now returns ordinal 3 for `valid@1, malformed@2, valid@3`, where
its old unguarded `json_extract` count threw. This is a real exception-behavior
change, so “identical to before” is not literally true for that point API.
It is consistent with the existing ordinal-only/full/page readers' hole.
`malformed earlier rows now consume an ordinal rather than throwing in the point
lookup` pins the old exception and all three readers' ordinal 3.

The same test registers an isolated raw provider, invokes the actual
`resolveOrdinalsForModule` ordinal-page walk and `encodeOpenCodeMessagesToCk`,
and verifies CK ingress ordinals `[1,3]`. It also calls `readSessionChunk` on
ordinal 3, the range reader used by `ctx_expand` and historian, checking the
later message ID, index and text. In `module-wire.ts:282-292`, a malformed row
contributes to the canonical count even though its JSON is invalid; the later
message receives `absolute_ordinal:3`.

The Rust OpenCode codec (`crates/mc-module/src/codec/opencode.rs:51-61`) honors
that explicit unsigned ordinal. Without an explicit ordinal it enumerates every
parsed array element: `[null, valid]` gives the valid row ordinal 2, not 1.
Invalid JSON *syntax* cannot be passed as `serde_json::Value`; that is different
from a malformed parsed row. No live host or native daemon malformed-store
integration was run. The offline canonical ingress/range comparison supports
this specific recovery change; it is not proof for every corrupt store shape.
Numeric `summary:1` versus boolean `true` already differed between some SQL and
application predicates before this change and is not a new finding here.

### Tag summaries, reasoning and stripping

The feared **cross-process counter hole is closed for normal writes**:
`readTagOwnerSummary` checks both the process counter and `PRAGMA data_version`.
`external process writes: data_version refreshes owner maxima and reasoning
estimates` primes the parent cache, writes with an unwrapped `bun:sqlite`
connection in a real child process, and observes cutoff 6 and estimate 1000 in
the parent. The child cannot increment the parent's generation. Existing summary
tests additionally cover local appends/backfill/owner reassignment/deletes,
another connection's delete and rollback. Status/drop mode are not summary
inputs: both old and new queries include dropped tags, so a status-only
`ctx_reduce` write is not by itself stale-owner evidence.

The cache holds numeric owner maxima and estimates, **not mutable `TagEntry`
objects**. `ReadonlyMap` is a TypeScript contract rather than a frozen runtime
Map. No production consumer mutating it was found; hostile casts are not counted
as a delivered defect. Other-process commits may cause a whole-summary rebuild,
but ordinary same-process unrelated writes do not use a whole-database stamp.

`strip-content.ts` now accepts already-decoded frozen part selections from the
budget pass. Its legacy bare-ID branch remains: exact frozen part selections
replay without planning newly eligible siblings, while legacy IDs still invoke
the historical layout-dependent planner. The frozen-parts differential, legacy
strip controls and reasoning-removal replay controls pass. Recomp/removal/clone
storage suites also pass, although no complete live Pi/OpenCode concurrent
session-clone/compactor scenario was exercised.

### LKG (last-known-good) digest reuse

`noteEntry` compares both stable ID and an unambiguous typed, length-prefixed
content key before reusing a digest; it does not trust ID alone. The new digest
suite compares reused results with full hashing after same-ID text edits, type
changes and head trims. Existing LKG replay tests reject stable-ID content drift.
Those tests pass. No stale-digest reproduction was found. Rust capture's primitive
field snapshots/exact-prefix comparison were inspected, not tested against a
live RPC/daemon in this review.

### Off-thread search and SQLite serving effects

Both worker and fallback call the same message-search implementation. Exact
array/order and diagnostics comparisons pass; the successful delegation test
observes no message FTS statement on the caller connection. The injected error
partner proves fallback; the existing in-memory-store partner also passes.
`a fresh message worker observes a committed index update` runs a real worker,
commits another indexed message, and compares a new worker's nonempty results
to the current in-process result array. Each request creates a new worker,
so this path has no long-lived message-search snapshot.

The actual worker opens all jobs except the distinct `backfill` job read-only
(`auto-search-worker.ts:81-84`); `ctx_search` sends `job:"messages"`. No new worker
write path was found. Writes racing **during** an active search snapshot were
not proven linearizable, and the packaged runtime reader/write-isolation tests
could not pass in the remote environment (see below).

The SQLite diff adds identity-write classification, the global generation and
execution hooks to the existing transaction/acquisition wrapper. It affects
served reasoning cutoff inputs through cache invalidation; the two write-form
defects above are therefore semantically relevant, not infrastructure-only.

## Verification and limitations

All test commands used Bun **1.4.2 (744846f84)** on Linux, with `OPENCODE_DB`
unset and `BUN_JSC_useOMGJIT=0` for direct test invocations.

1. **Ancestor/tip comparison by full test name:** 17 files, **214 pass, 0 fail,
   4079 expectations on each**, with all 214 names/outcomes identical. Selection:
   `reasoning-budget`, `reasoning-budget-status`, `reasoning-removal`,
   `reasoning-token-budget-review`, `reasoning-token-budget-re-review`,
   `integration-reasoning-replay`, `lkg-slot`, `lkg-entry-projector`, `lkg-persist`,
   `lkg-replay-fit`, `lkg-transform-replay`, `strip-content`,
   `strip-structural-noise`, `stripped-command`, `prefix-trim-pure-replay`,
   `temporal-replay`, `transform-caveman-replay-order-review` (all `.test.ts` under
   `src/hooks/magic-context`). Invocation in each package:
   `env -u OPENCODE_DB BUN_JSC_useOMGJIT=0 bun test --timeout 30000 <selection>`.
   This compares the assertions' outcomes, not provider-wire captures for every
   possible pass type.
2. **Strict reproductions:** staged the live new tests, confirmed empty unstaged
   diff, temporarily replaced `test.failing` with `test` under a marked
   `NON-VACUITY BREAK`, and ran each finding prefix with
   `bun test --test-name-pattern <prefix> <three-review-files>`. Each of nine
   filtered runs had **exactly its named defect fail and its partner pass**;
   no setup/error or unrelated test failed. The diff during the probe was
   `3 files changed, 9 insertions(+), 6 deletions(-)`. Restored from the staged
   live files, touched them, and confirmed an empty unstaged diff. The ancestor
   ran the five cache probes as ordinary tests: **5 pass, 0 fail, 28 expectations**.
3. **Full plugin suite**, launched in the background on Linux and awaited with
   `bash_watch`: `env -u OPENCODE_DB bun run test`, which runs the package's
   four-worker/30-second runner and frozen install. **7556 pass, 19 skip,
   10 fail; 7585 tests / 754 files / 219387 expectations**. This was the delivered
   tip before adding the report tests. Frozen install checked 1010 installs
   across 1251 packages, with no dependency changes.
4. The ten full-suite failures were rerun on **both** ancestor and tip: identical
   **0 pass, 2 skip, 10 fail / 12 tests / 2 files**. Nine are
   `review bundle: [packed ]<harness> worker under <runtime> loads, restarts,
   reads only and shuts down` in `auto-search-bundle-review.test.ts` (missing
   built `dist/auto-search-worker.js` and packed runtime artifacts). The tenth is
   `Node WASM Transformers fixture > builds with real fs and persists a model
   for offline reuse`, reporting `Cannot find module 'onnxruntime-web/webgpu'`
   from the temporary WASM bundle. These are remote/baseline verification gaps,
   not attributed to this diff. The local preparatory build in the brief does
   not supply artifacts to remote jobs.
5. `pure-replay-differential.ts` was **not run**: even `--ts-only` invokes
   `TestHarness.create` and starts an OpenCode host (`:120-127`). It removes the
   native-daemon requirement, not the host requirement. The host-free plugin
   replay suites above were run instead; no compatibility harness was invented.
6. An initial comparison job was refused before execution because symlinked
   `node_modules` in the extracted ancestor conflicted with remote sandbox
   setup. The symlinks were removed, after which the remote comparison ran.
   No local-test fallback or live-store override was used.

7. **TypeScript 5.9.3:** `bun run typecheck` passed (the package script checks
   retina-local-fs, plugin source and plugin scripts). Because the normal plugin
   tsconfig excludes `.test.ts`, a temporary config extended it with an explicit
   include of the three new test files and worker fixture and removed that
   exclusion; `tsc --noEmit -p tsconfig.oc-stall-review.json` also passed. The
   temporary config is not part of the delivery.
8. **Final focused gate:** `env -u OPENCODE_DB BUN_JSC_useOMGJIT=0 bun test
   --timeout 30000` selecting the three new review tests plus
   `read-session-raw-ordinal-watermark`, `storage-tag-owner-summary`,
   `search-message-history-off-thread`, `reasoning-budget-frozen-parts`,
   `lkg-entry-digest-reuse`, `storage-clone`, `shared/sqlite` and
   `tools/ctx-reduce/tools` test files: **70 pass, 0 fail / 11 files /
   926 expectations**. Nine are expected-failure assertions; the remaining
   61 are ordinary passing tests. This includes the final CK ingress/chunk
   malformed-row assertions added after the strict failure probes.
9. **Formatting:** repository-local Biome **2.5.1** formatted only the four new
   TypeScript files. No manifest, lockfile or production file changed.
10. The AFT scoped `inspect` tool found no diagnostics on
    `oc-stall-search-review.fixture.ts`, but returned
    **PARTIAL** because the checkout call graph was unavailable and the test files
    lacked authoritative analyzer coverage. The explicit TypeScript gate above
    provides coverage for those test files; the partial inspection is not
    represented as a clean whole-package analysis.
