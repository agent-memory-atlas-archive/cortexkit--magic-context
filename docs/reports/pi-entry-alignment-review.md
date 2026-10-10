# Review: Pi entry-id alignment (f4533524ad..5067b17489)

Scope: `packages/pi-plugin/src/context-handler.ts` (visible-only positional
lane, per-position header checks, fallback-adoption header filter) and its
tests `pi-entry-alignment.test.ts` and `append-pass-work-bound.test.ts`.
Report only; no product code changed. New tests live in
`packages/pi-plugin/src/pi-entry-alignment-review.test.ts`. The served-byte
instrument is `packages/pi-plugin/scripts/experiments/alignment/differential.test.ts`.

## Summary

- No input was found where a positional assignment passes the checks and the
  id is wrong, apart from the intended case where a message rewritten in place
  keeps its header (that message keeps the entry's id; see "Holds").
- Served bytes match the base build on fresh sessions, on the Pi replay and
  byte-identity suites, and when a session restarts onto the new build at any
  point in the default script. They differ in one case: fingerprint-identical
  messages after a restart that happens after a compaction (finding 1).
- The change fixes a base bug: on Pi 0.87 with a persisted system entry, one
  extra message from another extension made the event as long as the
  projection that still counts the system entry. Base then trusted that
  projection without checks, every id moved by one slot, and every message got
  a new tag. The partner test of finding 1 fails on base and passes on the tip.
- The fallback header filter is sound: it produces the same adoptable set as
  hashing everything. The `entry_fingerprint` NULL side effect cannot change a
  served byte.
- Merging with issue 650 needs a deliberate resolution: two textual conflicts
  plus one semantic interaction that turns finding 1 into a refused turn.

## Findings

### 1. Tags of fingerprint-identical messages change when a pass switches lanes. Severity: Low on this branch; Medium once merged with issue 650

Two messages with the same header and content (for example "continue" sent
twice in one millisecond) resolve to their real entry ids on the positional
lane. The fingerprint lane leaves them unresolved, so they get index-based
`pi-msg-*` ids. Any pass whose event length differs from the projection takes
the fingerprint lane. Examples: another extension appends a message, Pi omits a
failed attempt (finding 2), or the newest message is not persisted yet. On that
pass both messages get new `§N§` tags, and the next aligned pass switches them
back. Each switch changes the served prefix from the first of the two messages
onward.

- Test: `keeps the served tags of two identical same-millisecond messages when
  another extension appends a message on one pass` (`test.failing`). Output
  with `.failing` removed: tags `[3, 4]` on pass 1, `[6, 7]` on pass 2 (one
  extra message), `[3, 4]` on pass 3.
- Partner: `keeps the served tags of two distinct messages when another
  extension appends a message on one pass` passes on the tip. On base
  f4533524 the same test fails with tags `[3,4]` then `[8,9]`: base re-tags
  every message on that pass (the base bug described in the summary).
- Restart onto the new build (differential, scenario `kept-duplicates`): base
  tagged the pair under `pi-msg-*` ids. After the restart the tip resolves it
  to real ids, adoption skips the ambiguous fingerprint, and the pair gets new
  tags: `10,11 → 14,15` (restart after pass 6) and `10,11 → 16,17` (restart
  after pass 7). This is a one-off cache bust per affected session, and a
  dropped pair would come back as active.
- With issue 650 merged (scratch merge, see "Coordination"), the same test
  no longer re-tags. `guardPiMessageAllocations` throws
  `PiTagIdentityConflictError: ... the message's existing entry cannot be
  safely resolved; no second tag was allocated. This turn was refused without
  sending raw history; resending alone will not repair it`. Every
  fingerprint-lane pass in such a session is refused. With a Pi `context_edit`
  omission that lasts until the next compaction.
- How likely: the trigger needs two messages equal in role, timestamp,
  responseId, toolCallId and content. Pi stamps every message and assistant
  messages carry distinct responseIds, so this mostly means repeated user text
  in the same millisecond.
- Possible fixes: (a) when lengths differ, use a header-checked anchor
  alignment, in the style of `reconcilePiLkgEntryIds`, before falling back to
  per-message fingerprints, so ambiguous runs between verified anchors keep
  their real ids; (b) in adoption, when an ambiguous group has the same number
  of `pi-msg-*` rows and real ids, pair them by the index order the `pi-msg`
  ids encode.

### 2. Pi 0.87.1 `context_edit` omissions keep the positional lane off. Severity: Medium (performance only; ids stay correct)

Pi 0.87.1 appends `{type: "context_edit", targetId, replacement: null}` before
every automatic retry and every overflow recovery
(`agent-session.js` `_omitRecoveryAttempt`). `buildSessionProjection` then
drops the target from the context. `buildPiAlignedVisibleEntryIds` and the
incremental append path ignore `context_edit` entries. The visible list stays
one longer than the event until a compaction moves the omitted entry out of
the retained range. Until then every pass hashes every message on the
fingerprint lane, which is the cost the change set out to remove. Through
finding 1 it also feeds lane switches.

- Test: `uses the positional lane after Pi omits a failed attempt with a
  context_edit entry` (`test.failing`). Output with `.failing` removed: `ids`
  match, `hashed` expected 0, received 5.
- Partners: `uses the positional lane when the failed attempt was not omitted`
  (passes, hashed 0) and `still resolves every id through the fingerprint lane
  after the omission` (passes: ids stay correct).
- Differential evidence: the `context-edit-omission` pass has `collect=1` on
  the tip in both shapes. The pass after the compaction is back on the
  positional lane (`collect=0`).
- Suggested fix: apply null-replacement `context_edit` targets in the visible
  projection. Edits with replacement content keep the header, so they already
  align. A `context_edit` in an appended suffix must trigger the full rebuild,
  as a compaction does today.

## Holds (checked; no finding)

Positional checks (tests in `pi-entry-alignment-review.test.ts`, all pass):

- `keeps the positional lane when the host adds late fields such as
  completedAt and contextSnapshot`: header and fingerprint read only
  responseId, timestamp, role, toolCallId and content.
- `checks content when messages without timestamps share a header, and
  resolves a swap by content`.
- `leaves two swapped custom messages from one millisecond unresolved instead
  of trading their ids`.
- `realigns after /tree navigation and keeps appending on the new branch
  without hashing`: the branch summary gets its own id; the cache rebuilds on
  the branch switch and then grows on append.
- Mutation check: disabling the shared-header content check (`> 1 &&` →
  `false &&`) failed exactly the existing `checks content where two entries
  share every header field`, plus the no-timestamp and custom-swap tests above.
- Intended boundary: `gives a message rewritten in place with its header
  unchanged the id of the entry it replaced`. Where a header is unique, it
  serves as the identity. This matches the unchecked positional lane that base
  already used for sessions without a system entry. On base, Pi 0.87 sessions
  with a system entry left such a message unresolved instead.
- Compaction: the single leading `undefined` slot (summary; the system snapshot
  is withheld), `firstKeptEntryId` missing, pointing after the compaction, or
  equal to the compaction id all mirror Pi 0.87.1 `buildContextEntries`.
  Earlier compactions inside the kept range emit nothing on either side. Both
  replay shapes reach the positional lane on the pass after a compaction.
- Branch summaries and custom messages: roles `branchSummary`/`custom`, with
  timestamps from `new Date(entry.timestamp).getTime()`, match
  `messages.js`. `NaN` matches `NaN` via `Object.is`, and a `-0`/`0`
  difference only forces the fallback.
- Hosts that still show system messages (the shape OMP may use): the
  differential's `systems` shape uses the list that counts system entries and
  stays positional through compaction (`[undefined, undefined]` head).

Adoption header filter:

- `finds the same adoptable fingerprints with and without the header filter`
  covers an exact match, a header match with different content (hashed, then
  rejected), and a row whose header no longer matches any message (skipped;
  it could never match, because the fingerprint contains the header). Equal
  fingerprints imply equal headers: the header is the first four fingerprint
  fields, serialized the same way, and a JSON round trip of strings, numbers
  and null is stable. Rows of unexpected shape make the filter hash every
  message. NULL rows are skipped and could never match the `IN` query anyway.
  Mutation: making the filter skip every tagged message failed this test and
  the existing `keeps every reusable message whose fingerprint a fallback row
  could carry`.
- Race: the headers are read after `preflightRevision`. A fallback row
  committed later changes `data_version`, and the rebuild then runs under the
  writer with headers read again.
- `entry_fingerprint` NULL: when fallback rows exist, a new tag row for an
  already-tagged real-id message now stores NULL. Base stored the fingerprint;
  it already stored NULL whenever no fallback rows existed. The column is read
  only by adoption (`message_id LIKE 'pi-msg-%'` rows, which are never
  already-tagged, because those ids come from resolved real entry ids), by the
  inert-whitespace replay (values it writes itself, with its own prefix), and
  by session clone (copied unchanged). No served byte depends on it.

## Byte identity

Instrument: `scripts/experiments/alignment/differential.test.ts`. It drives
the real `context` handler through a hand-built Pi 0.87.1 session (system
entry, custom message, two identical same-millisecond users, branch summary,
`context_edit` omission, compaction, appends), projected with Pi 0.87.1's
`buildSessionContext`. Each pass prints a sha256 of the served array, its tag
list and the lane counters. The base side ran from `git archive f4533524ad`
in `/tmp` with this checkout's `node_modules` linked in; `packages/plugin` is
the same on both sides apart from one test file.

| Run | Result |
| --- | --- |
| Fresh session, `default` and `kept-duplicates` scripts, `pi087` and `systems` shapes (32 passes) | identical sha256 on every pass |
| Restart onto the tip after pass k, `default`, k = 1..7 | identical |
| Restart onto the tip after pass k, `kept-duplicates`, k = 1..5 | identical |
| Restart onto the tip after pass k, `kept-duplicates`, k = 6, 7 | differs (finding 1) |
| Lane counters, `pi087` shape | base: `collect=1` on passes 1-7; tip: `collect=0` except the omission pass |

Repository replay and byte-identity suites (`issue-485-replay-gate`,
`native-replay-pi`, `native-replay-state-pi`, `reasoning-replay-pi`,
`fold-content-replay`, `overwall-upgrade-replay`,
`issue-640-641-combined-differential`, `served-array-ledger`,
`served-collision`, `served-identity-refusal`, `resolve-pi-stable-id`,
`transcript-pi`, `tail-hygiene-parity`): 112 pass, 5 skip, 0 fail on both
base and tip, with identical outcomes per test name. The issue-485 gate
compares against its committed pre-fix fixture.
`packages/e2e-tests/scripts/pure-replay-differential.ts` drives an OpenCode
host, not Pi, so it was not used.

Full Pi suite on Linux (ck-motor, Bun 1.4.2, throwaway HOME, tip plus the new
review files): 1786 pass, 10 skip, 0 fail across 187 files.

## Coordination with issue 650

Branch `alfonso/task/bg_c673f4e5e72c28d4-issue-650-...` (head 3e93db01e2, base
691725de, an ancestor of f4533524). `git merge-tree` reports conflicts only in
`context-handler.ts`:

1. `getPiBranchEntryLookup` object literal. Issue 650 adds
   `entryIdsByToolIdentity` and indexes only entries in `alignedEntryIds`
   (`visibleIds`). The tip adds `alignedVisibleEntryIds`, `alignmentChecks` and
   `alignmentHeaderCounts`. Keep every field and use `aligned.all` for
   `alignedEntryIds`. Every visible id is in `aligned.all`, so every emitted
   entry still gets an alignment check. The tip's append path calls
   `addPiBranchEntryToLookup` directly, which is correct because appended
   entries are emitted.
2. `piMessageEntryFingerprint`. Issue 650 moves it to
   `pi-message-identity.ts` and drops the `stableStringify` import. The tip
   counts its calls (`piEntryFingerprintCount`) and adds
   `piMessageEntryFingerprintHeader` and `readPiFallbackFingerprintHeaders`
   next to it. Keeping the tip's copy fails with `ReferenceError:
   stableStringify is not defined`. A working resolution: import the moved
   function under another name and keep a local wrapper that counts and then
   delegates. If the counter is dropped, `readPiEntryFingerprintCount` stays 0
   and both work-bound tests (`hashes the same number of messages on an
   append pass at 1k and 10k messages`, `uses the positional lane without
   hashing when every position matches`) pass without measuring anything. The
   moved function keeps the same five-field layout, so the header filter stays
   valid.

With both conflicts resolved this way, `pi-entry-alignment*.test.ts`,
`append-pass-work-bound.test.ts` and the three `issue-650*.test.ts` files gave
64 pass and 2 fail. The 2 failures (`review 650: a served message-tag conflict
(issue comment 2) is still not an identity refusal` and its `test.failing`
partner) fail the same way on the issue 650 head alone, so the merge did not
cause them.

Functions both branches touch (most auto-merge; review them together):
`__test` exports, `addPiBranchEntryToLookup`, `getPiBranchEntryLookup`,
the `piMessageEntryFingerprint` region, `adoptPiFallbackTags` (650 adds the
unique-real-id requirement, survivor proofs and `PiTagIdentityConflictError`;
the tip makes `rebuildFingerprints` unconditional and header-filtered), the
`runPipeline` adoption block (650 adds `guardPiMessageAllocations(...,
entryFingerprintByMessageId)` right after the tip's filtered map), and
`registerPiContextHandler` (separate blocks). The tip renames the transaction
label to `pi_fallback_adoption` (also in
`packages/plugin/src/shared/write-transaction-attribution.test.ts`); 650 keeps
`pi_compaction_queue` in an unchanged line, so the merge takes the tip's.

Semantic interactions:

- `guardPiMessageAllocations` runs one query per map entry when fallback rows
  exist. The tip's header filter shrinks that map. Leaving out tagged messages
  whose header matches no fallback row is safe for the guard, because it
  throws only when a `pi-msg-*` row has exactly the same fingerprint.
- The tag switch of fingerprint-identical messages (finding 1) becomes a
  refused turn after the merge (reproduced on the scratch
  merge with the finding 1 test, `.failing` removed).
- 650's `realIdsByFingerprint.get(fp)?.length !== 1 → continue` keeps the
  ambiguous restart case of finding 1 unadopted.

## Could not check

- Oh My Pi: not installed in this workspace. Its real event shape (whether it
  shows system messages, where its system prompt message comes from, whether it
  changes header fields after persisting) is inferred from the brief, not
  observed. Late non-header fields are covered by the late-fields test; a late
  change to responseId or timestamp would only force the fingerprint lane,
  because the cached checks are taken when an entry is added.
- A live Pi host run: every replay here uses a hand-built entry tree with Pi
  0.87.1's `buildSessionContext`, not `ExtensionRunner.emitContext` inside a
  running agent.
- How often real sessions contain fingerprint-identical messages, and how
  often Pi sessions contain `context_edit` omissions.
- The issue 650 merge was a scratch resolution in `/tmp`, not the merge that
  will land.

## Reproduce

```sh
cd packages/pi-plugin
bun test src/pi-entry-alignment-review.test.ts
# Served-byte differential (run in both checkouts and diff the ALIGN_DIFF lines)
MC_ALIGN_DIFF=1 bun test scripts/experiments/alignment/differential.test.ts
MC_ALIGN_DIFF=1 MC_ALIGN_SCENARIO=kept-duplicates bun test scripts/experiments/alignment/differential.test.ts
# Restart after pass k: serve [0,k) with one build and [k,end) with the other
MC_ALIGN_DIFF=1 MC_ALIGN_SCENARIO=kept-duplicates MC_ALIGN_DB=/tmp/x.db MC_ALIGN_FROM=0 MC_ALIGN_TO=6 bun test scripts/experiments/alignment/differential.test.ts
MC_ALIGN_DIFF=1 MC_ALIGN_SCENARIO=kept-duplicates MC_ALIGN_DB=/tmp/x.db MC_ALIGN_FROM=6 bun test scripts/experiments/alignment/differential.test.ts
```
