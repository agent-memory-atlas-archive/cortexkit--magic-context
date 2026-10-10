# Pi raw-ordinal offset: independent review

## Scope and disposition

Reviewed `1c8526be` (pre-fix master) through
`ccc28113be27aca4817c5527119e5063f7b28b4d` (delivered fix): 12 files. This is
report-only: no production code or existing tests were changed. New regressions
are in `packages/pi-plugin/src/pi-ordinal-offset-review.test.ts`.

**The fixture recovers automatically, and the exercised offset-zero replay
paths remain byte-identical. Three correctness gaps remain:** unavailable
prefix slots are presented as recoverable system messages in two expansion
modes; an unanchored expansion can return the wrong messages; and an anchor
query error is reported as verified alignment rather than an unresolved state.
The latter two are limitations of the new fallback, not evidence of a healthy
session's provider bytes changing. No wrong native marker cut was observed in
the exercised offset boundaries.

The four Bun `it.failing` tests are marked as expected to fail: their assertions
encode the desired contracts, not the current wrong output. Bun treats an
observed assertion failure as success for these tests, and an unexpected pass as
a suite failure. Each has a normal passing partner. Temporarily making each expected
failure a normal `it` produced exactly one failure and one passing partner;
those controls were restored before the verification gates.

## Findings

### 1. P2 — Missing prefix history is advertised as recoverable system history

**Reproduction:** seed two stored compartments (summaries with message-range
boundaries) covering ordinals 1 through 65,938, with an
anchored surviving branch requiring offset 65,920. Request either
`ctx_expand(start=1001, end=1002, verbose=true)` or
`ctx_expand(message=1001)`. Those messages no longer exist on the branch.

Actual verbose output:

```text
Messages 1001-1002 (verbose). Recover any one in full with ctx_expand(message=<ordinal>):

[1001] system

[1002] system
```

Actual single-message output:

```text
[1001] system — full recovery:

  (no recoverable content — message had only structural/reasoning parts)
```

Neither describes the lost message honestly: there was no system message there,
and its original content was not examined. A wide verbose range also consumes
output budget listing fictitious system messages. Ordinary, nonverbose expansion
correctly says `No messages found`; reachable expansion recovers the right text.

**Source:** `read-session-pi.ts:382-390` creates empty `role: "system"` slots;
`tools/ctx-expand.ts:150-151,171-196` passes them to the shared renderers.
`packages/plugin/src/tools/ctx-expand/render.ts:233-256,272-304` treats every
returned slot as an actual message. This is a new interaction between the offset
prefix representation and unchanged renderers.

**Tests and partners:**

- `unreachable verbose range: reports unavailable instead of invented system messages`
  (`it.failing`)
- `unreachable verbose range partner: ordinary range reports no messages`
  (passes)
- `unreachable single message: reports unavailable instead of full recovery`
  (`it.failing`)
- `unreachable single message partner: a reachable stored ordinal recovers the right text`
  (passes)

**Suggested direction, not implemented:** distinguish unavailable ordinal slots
from real structural messages at the expansion boundary, without renumbering
later messages or losing dense ordinal addressing.

### 2. P2 — An unanchored `ctx_expand` can silently return unrelated messages

**Reproduction:** use the same shifted session, then navigate to a branch ending
before `anchor-call`. The newest compartment's end ID is no longer reachable,
so alignment correctly reports `unanchored/anchor-missing`.
Request stored range 1–2. Those original entries are not on this branch. Actual
output instead contains the surviving branch's messages at stored 65,921–65,922:

```text
Messages 1-2 (2 messages, ~14 tokens):

[1] A: reachable 1
[2] U: reachable 2
```

The user-visible labels now identify different messages than the stored
compartments/search coordinates. There is no warning in the tool result.

**Source:** `pi-ordinal-alignment.ts:140-147,249-268` maps an unanchored state to
numeric offset zero for raw readers. `tools/ctx-expand.ts:132-151,199-209` neither
rejects that state nor tells the caller it is using branch-local coordinates.

**Contract distinction:** the implemented resolver leaves unanchored readers on
plain numbering. This test documents why that compatibility choice is not safe
for recovery of *stored* ordinals; it is not alleging that the historian's
unanchored gate failed. Master also used plain numbering in this situation.
Rejecting ambiguous stored-coordinate expansion would change that fallback's
behavior, but would satisfy the review's requirement not to return wrong history.

**Test:** `unanchored expansion: refuses a lost stored range instead of relabeling branch messages`
(`it.failing`).

**Passing partner:** `unanchored expansion partner: a placed offset never aliases the lost stored range`.
With the anchor still reachable, offset 65,920 correctly makes stored range 1–2
unavailable instead of returning branch-local messages 1–2.

### 3. P2 — Failure to read anchors is indistinguishable from proven alignment

**Reproduction:** in an otherwise anchored shifted fixture, make only the
alignment anchor SELECT throw `fixture anchor read unavailable`. Other database
queries continue to work. `resolvePiOrdinalAlignment` returns
`{ kind: "aligned", offset: 0 }`; `isPiOrdinalAlignmentUnanchored` returns false.
Without the injected error, the same fixture proves offset 65,920.

**Source:** `pi-ordinal-alignment.ts:218-228` catches the read failure and returns
`ALIGNED`. The historian gate at `context-handler.ts:5819-5826` and ordinal marker
gate at `compaction-marker-manager-pi.ts:82-94` only pause for `unanchored`.
A transient query failure therefore bypasses these alignment gates, even though
no coordinate relation was established. Plain numbering may still be a
compatibility fallback for read-only callers; claiming it is verified alignment
is a separate issue.

**Test:** `anchor read failure: does not claim shifted history is aligned`
(`it.failing`).

**Passing partner:** `anchor read failure partner: a readable anchor proves the offset`.
The same surviving entries give offset 65,920 when the anchor query succeeds.

**Limit of this reproduction:** it proves the false alignment classification,
not a durable incorrect compartment publication or a wrong cut after a database
fault. The fixture has a short suffix; a separate long-suffix fault-injection test
would be needed to establish those downstream effects. This is a new resolver
failure-path gap, not a claim about the cause of ANTAUTH's missing parent.

## Positive coverage and boundaries

### Persisted missing-parent recovery

`a missing mid-file parent recovers automatically, grows, and leaves the defer head unchanged`
uses Pi's real `SessionManager.open`, an explicitly generated temporary JSONL,
and the real context handler/historian runner. Only the historian model call is
mocked. All SQLite databases are fixture databases.

The complete fixture contains 66,081 message entries (66,080 folded raw ordinals).
Removing one interior entry leaves 66,080 entries in the file but only 161
reachable entries, corresponding to 160 raw messages. The first reachable entry
is an assistant at `2026-10-05T10:41:39Z`, with a missing parent. The stored end
65,938 is now branch ordinal 18, giving offset 65,920. This deliberately scaled
suffix preserves the missing-parent/high-stored-coordinate shape, not ANTAUTH's
exact 91,739-line / 18,528-entry counts.

Assertions establish:

- The real branch walk stops at the missing parent while the older rows remain
  in the file.
- The derived offset remains constant after a real appended user turn.
- The JSON-serialized m[0]/m[1] head, **including timestamps**, is unchanged by
  the break, growth, historian trigger, and a cache-hot deferred pass after publication
  (a recent response with an unexpired cache TTL).
  The visible-tail start stays fixed, as it does after a native compaction;
  sliding the window would independently change synthetic-head timestamps.
- The first historian input starts at **65,939**, includes the folded results
  and subsequent answer, and publishes a compartment starting at
  `synth-user-result-a`, with no repair command.
- Putting the missing parent back into the JSONL and reopening the manager
  restores the full branch and derives offset zero, even after publication.

### Marker boundaries

`marker cuts use stored ordinals at the anchor, first entry, and newest entry`
checks the offset-aware native-boundary helper with literal expected entry IDs:

| Last compacted ordinal | Expected native result |
| --- | --- |
| 65,920 (just before first reachable raw message) | `b1` |
| 65,921 (first reachable raw message) | `b2` |
| 65,938 (anchor/tool call) | no cut: next message is synthetic tool results |
| 66,079 (just before newest reachable raw message) | `b160` |
| 66,080 (newest reachable raw message) | no cut: nothing follows |

The actual deferred marker manager is also exercised: it waits at the synthetic
result boundary without calling `appendCompaction`, then, after coverage advances
through the results and answer at 65,940, appends exactly `firstKeptEntryId=b21`.
These expectations are entry IDs and literal coordinates, not values calculated
by the alignment resolver itself. The existing offset-zero marker wire-stability
suite also passes on both reviewed commits.

### Tool arcs and historian resumption

`offset chunk ends do not split completed tool arcs; resumption preserves the stored start`
gives the chunk reader a one-token budget at the invocation and confirms it
includes the whole completed two-result arc, through 65,939. The raw page at
65,939 independently identifies both call IDs and `synth-user-result-a`.

**A starting boundary can already be inside an arc:** if the persisted end is
65,938 (the call), resumption at 65,939 starts with the results. The shared reader
fetches the predecessor for pairing but does not emit/rewind below its requested
start (`read-session-chunk.ts:1112-1127,1163-1171,1285-1291`). The existing delivered
live test also explicitly expects this result-start. This is inherited from the
persisted boundary, not an offset-created off-by-one. Newly budget-selected ends
are kept arc-complete in the exercised case; the native marker refuses a
synthetic first-kept boundary. These three properties should not be conflated.

### Branch changes and concurrency

`growing and healing branches keep independent offsets without identity-only logs`
checks growth, replacement arrays with identical content (one alignment log),
healing to offset zero, a tree branch before the anchor (`anchor-missing`), and
interleaved snapshot reads over separate healed/shifted arrays. Each reader's
function offset source is applied to the exact entries it reads; previously
returned alignment objects remain unchanged. The persisted test additionally
checks real host array growth and healing.

This does **not** prove arbitrary interleavings of two complete context handlers,
provider-slot replacement, or tree navigation during an already-running
`/ctx-wrapup` summarization command.
Those remain verification gaps, rather than claims inferred from the snapshot
unit test.

## Offset-zero differential results

The master snapshot was made with `git archive 1c8526be` **inside this isolated
worktree**, not by changing or reading the parent checkout. Both revisions ran
on Linux with Bun **1.4.2 (744846f84)**, a throwaway HOME, and
`git config --global --add safe.directory '*'`; `OPENCODE_DB` was not exported.

The same 15 suites ran at both revisions with JUnit reporting:

```text
issue-485-replay-gate, native-replay-pi, native-replay-state-pi,
reasoning-replay-pi, fold-content-replay, overwall-upgrade-replay,
issue-640-641-combined-differential, served-array-ledger, served-collision,
served-identity-refusal, resolve-pi-stable-id, transcript-pi,
tail-hygiene-parity, marker-drain-wire-stability, system-ordinals-pi
```

**117 pass, 5 skip, 0 fail on each revision (122 tests / 15 files).** Comparing
sorted `(classname, test name, outcome)` triples from the two JUnit reports gave
exact equality, with **no changed outcomes per test name**. Both triple lists
have SHA-256:

```text
8733837356b239cc393f744c104a66995a58e4d15b49cf8041ff5e0d354bab57
```

The five unchanged skipped test names are `F pure replay child`, `removal marker child`, and
`independent Pi/OpenCode1/OpenCode2 defer bytes and per-pass cost`. Child-process
coverage that the suites themselves invoke still runs; the opt-in independent
cost tests were not enabled.

Additionally, the existing
`scripts/experiments/alignment/differential.test.ts` ran with `MC_ALIGN_DIFF=1`
and each `MC_ALIGN_SCENARIO=default` / `kept-duplicates` on both revisions. It
projects with Pi 0.87.1 and drives the real handler. **All 32 served-array SHA-256
values match**, including both host shapes (`pi087`, `systems`) and every
scripted pass: plain, custom message, duplicate users, branch summary,
context-edit omission, compaction, append after compaction, and append.
SHA-256 of the newline-joined `ALIGN_DIFF` output lines, equal on both sides:

| Scenario | Served-array hash comparisons | Output digest |
| --- | ---: | --- |
| `default` | 16 | `b5b0f74c2a8744ed7751cffa1c4f0d95762dc03da1609433e81d60c3eefba2f0` |
| `kept-duplicates` | 16 | `c28a26b9d099a7a614618e72d6f86b1538d2c707ee1f934eb0abc798bfc5c134` |

These are comparisons of each build's independent output, not hashes of a file
compared to itself. The issue-485 suite also checks its committed pre-fix byte
fixture. Green outcomes alone do not establish universal byte equivalence;
the 32 served-array comparisons provide direct differential evidence for the
scripted paths.

## Expected-failure controls

For each row below, only its `it.failing` wrapper was temporarily replaced with
normal `it` and marked `NON-VACUITY BREAK`. The review test file was saved in the
Git index before mutation. The local `git diff --stat` was nonempty during each control
(`1 file changed, 1 insertion(+), 1 deletion(-)`) and empty after restoring with
`git checkout -- <path> && touch <path>`. The named test alone failed, its named
partner passed, and ten unrelated tests were filtered out:

| Test-name prefix / `bun test -t` | Observed red assertion |
| --- | --- |
| `unreachable verbose range` | expected unavailable; received `[1001] system` / `[1002] system` with recovery invitation |
| `unreachable single message` | expected no message; received `system — full recovery` |
| `unanchored expansion` | expected no `reachable 1`; received it as message `[1]` |
| `anchor read failure` | expected unanchored `true`; received `false` |

No production code was mutated, and no temporary wrapper change remains in the
committed files.

## Verification and remaining gaps

Commands ran on Linux unless noted. Every test run used a fresh temporary HOME
and `git config --global --add safe.directory '*'`, with `OPENCODE_DB` unset.
No live OpenCode/Magic Context database, user configuration, or Pi session store
was opened. ANTAUTH is the incident session whose missing-parent shape motivated
this review; its real JSONL was not available or required for these fixtures.
`c2fadca7` was treated as a missing **session-entry ID**, not as a repository Git
reference.

| Gate | Result |
| --- | --- |
| `bun run --cwd packages/pi-plugin test` at the delivered base, before review additions | Bun 1.4.2: 1,804 pass / 10 skip / 0 fail; 1,814 tests, 188 files, 85,321 assertions |
| Same full Pi command with review tests, background Linux job followed by `bash_watch` | Bun 1.4.2: 1,816 pass / 10 skip / 0 fail; 1,826 tests, 189 files, 85,375 assertions |
| `BUN_JSC_useOMGJIT=0 bun test src/pi-ordinal-offset-review.test.ts --timeout 60000`, from the Pi package, after final comment/style cleanup | Bun 1.4.2: 12 pass / 0 fail, 54 assertions; four passes are expected-failure tests |
| `bun run --cwd packages/pi-plugin typecheck` | TypeScript 5.9.3: exit 0; retina build config and Pi `tsc --noEmit` both passed |
| `bun run --cwd packages/pi-plugin lint` | Biome 2.5.1: 284 files checked, exit 0, ten existing warnings outside the new file, no new-file diagnostics |
| `bun run --cwd packages/pi-plugin format` (local file-formatting operation) | Biome 2.5.1: 284 files; only the new test file needed formatting, final run changed none |
| Scoped AFT inspection | Partial: checkout call-graph analysis not ready; not used as evidence of clean diagnostics. Package typecheck/lint are the authoritative checks |
| `git diff --check` / staged whitespace check | Passed |

The package test script performed `bun install --frozen-lockfile`: 1,010 installs
across 1,251 packages checked, no changes. No manifest or lockfile was edited.
The first baseline comparison attempt was refused *before execution* because a
linked `node_modules` was incompatible with remote workspace setup. Removing
that link let the remote provision dependencies normally; the successful
comparisons above were remote, not local fallbacks. The generated master
snapshot was removed after comparison.

Limitations worth retaining for follow-up:

- The 32 direct offset-zero replay comparisons and existing byte gates are not
  an exhaustive proof over every SOFT/SOFT+/HARD signal combination. In the offset
  fixture, heads are pinned across the break and deferred passes, including
  deferred publication, but the later rebuild that admits new historian content
  was not exhaustively exercised under every pressure/reclaim signal.
- Full-handler racing over different branches, concurrent command/provider
  replacement, and tree navigation between `/ctx-wrapup` preflight and later raw
  reads were not reproduced. Its preflight checks alignment once, while its
  offset source can read another branch later (`commands/ctx-wrapup.ts:220-242`).
  The independent snapshot test is not a substitute for that scheduling test.
- Existing `ctx_expand` offset tests exercise reachable ranges and unavailable
  nonverbose ranges; the new tests additionally pin the broken verbose/single
  modes and ambiguous unanchored recovery. Expansion while an already-registered
  provider owns an older branch snapshot was not tested here.
- The anchor-error finding is resolver-level fault injection. Downstream
  long-suffix publication/drain corruption after such a transient fault remains
  unproven. Similarly, no failure claim is made about recomp or message-end
  indexing beyond the passing full suite and inspection of their offset-source
  integration.
- No actual provider API request, provider-side cache accounting, 255k-token
  rewrite, or ANTAUTH file repair was attempted. Packaging/build was not rerun:
  this delivery adds only tests and this report, with no production or manifest
  change.
