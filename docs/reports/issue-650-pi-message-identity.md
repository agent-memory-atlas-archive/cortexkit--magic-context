# issue 650: ordinary message-tag follow-up

This extends the earlier repair for tool-call tag identities (commit `9ce293ec`)
to the ordinary-user-message recurrence reported in issue 650 comment 2. The reported
pair is an active real-entry `:p0` tag 20, with a queued drop, and an active
`pi-msg-0-<timestamp>-user:p0` tag 440. Their full entry fingerprints, 221-character
source strings, byte counts (233) and token counts (103) agree.

## A distinct reproduced identity-loss path

The live log does not identify the two unmatched message indices or supply its
315-message array / 349-entry branch. It is therefore impossible to identify the
reporter's exact two slots from those counts alone. There is, however, a concrete
second mechanism that requires **no edit to the ordinary user's prose**:

1. Pi retains old entries on the append-only branch after compaction. The emitted
   context is only the summary, entries starting at `firstKeptEntryId`, and later
   entries.
2. The old `getPiBranchEntryLookup` built its reference/fingerprint indices from
   **all ordinary branch messages**, not that retained projection. An older,
   non-emitted copy with the same timestamp, role and content makes the retained
   user's fingerprint bucket ambiguous.
3. Pi clones messages before context hooks. Reference matching misses; a bucket
   containing both copies is rejected. The retained user gets an unresolved id,
   despite having a real entry and unchanged text.
4. Pi synthesizes the native summary from a compaction marker rather than an
   ordinary message entry, so it has no real message-entry id to resolve. This gives
   exactly two unmatched slots in the small fixture: summary plus retained user.
   MC removes its own summary before tagging, so the retained user is now index 0
   and receives the reported `pi-msg-0-…-user:p0` form.
5. Exact-key allocation misses the old real `:p0` tag and mints another number.
   When canonical alignment returns, both recorded numbers trigger the old generic
   message adoption error and storage-busy refusal.

In `9ce293ec`, the all-branch loop is
`packages/pi-plugin/src/context-handler.ts:1919-1932`; the ambiguity rejection is
`:1741-1763`; temporary IDs come from `read-session-pi.ts:124-143`. Message tagging
uses the current `messageId:pN` key in `packages/plugin/src/shared/tag-transcript.ts`,
then `tagger.ts:514-549` / `allocateTag:404-465` allocate on an exact-key miss.

The entry-id lookup runs **before** the force decision and HARD fold. The fold
can reshape the last-known-good (LKG) replay and expose the later refusal, but
cannot retroactively cause those initial lookup misses. This differs from the
previous tool reproduction's whole-message prose fingerprint mismatch. Both
ultimately allow a temporary owner to miss an already-known tag.

This is evidence of a mechanism compatible with the report, not proof that the
reporter's branch contains duplicate fingerprints. Missing entries, rewritten
messages, and ordinary synthetic wrappers remain other possible explanations
for the live 313/315 count. Entries outside the active branch are not searched;
the reproduced offending entry is inside the branch but outside the retained
context window.

## Real Pi 1.1.0 reproduction

The real SDK driver `packages/e2e-tests/scripts/issue-650-host.ts`, launched by
`issue-650-probe.ts`, uses `ISSUE_650_MESSAGE=1` to enable the message/compaction
scenario instead of the tool scenario. It seeds two
ordinary users through the host's real `SessionManager`, with equal raw payload,
timestamp and role; tags a known real entry; then appends a real compaction whose
first-kept entry is the later user and rebuilds the real agent state through
`agent.state.messages`. A small synthetic framing message is used on the initial
and final passes to exercise canonical positional alignment. The failing middle
pass does not rewrite the ordinary user or insert framing.

The mock returns 178,473 input tokens with a 240,000-window / 36,000-output model
(usable limit 204,000). The fixture stores that observed usage and publishes
throwaway compartment summaries so the new history delta m[1] exceeds 15% of
the previously cached history block m[0] (which is above the 500-token floor).
That is the production injector's drift-refold condition.
This exercises the production scheduler and injector, not copied implementations.

The throwaway pre-change host run `host-bSeNTf` (under the evidence directory
listed below) logs:

```
collectMessageEntryIdsByRef: resolved=3/5 (fingerprint=3, branchEntries=8, messageEntries=6)
transform: usage=87.5% (178473 tokens, limit=204000) decision=execute force=true
pi m[0] HARD fold decision: reason=drift executed=true bustsServedPrefix=true
DEGRADED PASS Conflicting served Pi message tag numbers; refusing identity adoption:
LKG unavailable (lkg_invalidated_reshape); refusing unreduced 8-message input
```

The real retained tag 2 acquired fallback tag 5 with the same fingerprint and
source; the third provider request was refused. This is the same failure shape,
scaled down, with a real forced execute and HARD drift fold.

Fixed root `host-Xn5Lon` completed all three provider requests. Only the expected
synthetic summary remains unmatched (`4/5`); the retained user's real tag stays 2,
its entire served user object stays byte-identical, and no fallback row appears.
The older real-entry row remains distinct; equal fingerprints do not merge two
known real entries. The initial and final framing messages have distinct
synthetic timestamps, avoiding a separate unresolved framing-identity ambiguity.

The ordinary-message changes also preserve the previous real-host tool-call
checks: Pi 0.83.0 bash
(`host-URigaM`) and Pi 1.1.0 successful codemode (`host-2sF8pp`), each with four
provider requests and byte-identical tool results.

All runs use fresh HOME/cwd, isolated `.pi`, every XDG directory, OPENCODE_DB and
MAGIC_CONTEXT_STORAGE_DIR under the throwaway root. Opening/final `lsof -p` audits
for successful hosts list only that root's context.db/WAL/SHM. No live store or
configuration was accessed.

## Prevention and shared recovery

- Branch fingerprint/reference indices now contain only ordinary entries in the
  compaction-aware emitted projection. The existing suffix/compaction cache
  rebuild keeps those indices current.
- Two genuinely active entries with equal fingerprints still remain ambiguous.
  Message adoption also requires exactly one current fingerprint target, not just
  one fallback base. A pre-allocation guard refuses ambiguous real/fallback reuse
  instead of exposing a new number. No positional guessing or call-only/text-only
  identity merge is added.
- Both storage adoption functions use one `selectPiTagSurvivor` rule. Exact cached
  evidence wins; otherwise the one known-served number wins. Multiple served
  numbers without a proven current survivor throw `PiTagIdentityConflictError`.
  A losing executed drop cannot change a served active survivor's status.
- The error supports `message` and `tool` kinds. Message conflicts now use the
  accurate non-storage, non-resend host-abort path introduced for tools.

A last returned array can remain available even when LKG replay was invalidated
by reshaping. Both tag kinds now read those detached, digest-checked bytes first.
Cold recovery may use an LKG only when its exact serialized digest matches the
last returned-array ledger; capture alone is not a serve receipt.

For message collisions, current-byte proof requires exactly one candidate number
anywhere in the cached array, exactly one full raw-message fingerprint after
removing generated leading prefixes, and that number at the correct text-part
ordinal. Matching source text or timestamp alone cannot authorize deletion;
quoted marker text can veto repair but cannot establish it. This proof supports
active text (the reported shape). If rendered reductions prevent reconstruction
of the original full fingerprint, multiple-recorded-number recovery conservatively
refuses rather than guessing.

If current bytes prove 20, its row, source and pending drop remain. If they prove
440, the surviving row becomes the real `:p0` identity while the queued drop is
retargeted from 20 to 440, preserving its queue id/time. A queued drop does not
become an executed drop during adoption. The usual priced/protected drain policy
still applies afterward. Duplicate operations are deduplicated by the existing
fold code, not silently discarded wholesale.

## Tests and proof boundaries

`issue-650-message.test.ts` seeds exactly tags 20 / 440, both active, identical
221-character sources, 233 bytes / 103 tokens, and a pending drop on 20. Cases
cover both surviving numbers, sole-served evidence, hot reshape recovery, cold
digest evidence, both numbers in cache, absent proof, wrong full fingerprint,
wrong ordinal, and captured-but-unserved LKG. Refusals leave both rows, both
sources and the operation untouched. A full context-handler test verifies recovery
and three byte-identical defer passes while the queued drop remains pending.

The original tool recovery/collision tests continue to run against the shared
selector and shared cached-array reader. Tests preserve the existing refusal of
ambiguous active fingerprints and the branch-switch cold/warm projection contract.
Final Linux gates, mutation controls and artifact paths are recorded in the
worker delivery. Scope remains Pi; OpenCode behavior is unchanged.

Evidence root:
`/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-650/`.
Host roots retain `message-result.json` or `result.json`, requests, output, logs and
lsof audits. Verification/mutation evidence is outside regenerable build output.

### Existing-test contract changes

Three issue-640 review assertions previously allowed behavior that the new
byte-safe identity contract forbids. The two revision/racing-drop fixtures still
insert a dropped alias at their original writer-revision boundary, but now assert
an identity refusal and retain both the served active row and dropped alias.
They no longer expect adoption to rewrite an already-returned active message into
`[dropped §1§]`. A missed re-discovery would return normally and fail these new
refusal assertions, so the race-detection claim remains exercised.

The three-row unserved-ordinal fixture now asserts refusal with every row intact,
rather than treating a canonical key as permission to choose an unobserved number.
Its name explicitly changes to describe that contract. The adjacent positive
three-way served-fallback fold remains unchanged. Both low-level message and tool
adoption APIs now refuse a duplicate fold with zero recorded/cached proof, not
just their context-handler callers. The commit message records these changes;
no assertion was silently rewritten to conceal an implementation failure.

## Final verification

- Mac, Bun 1.4.2 / Node v26.10.0: the real Pi 1.1.0 message scenario passed three
  provider requests and asserted exact equality of the retained user objects;
  the 0.83.0 bash and 1.1.0 codemode tool scenarios passed four requests each.
  Opening and final lsof audits found only throwaway database paths.
- Linux, Bun 1.4.2: 46 focused identity/adoption/cost tests passed, including all
  17 new message tests; 22 existing projection/adoption/defer tests passed; the
  four selected issue-640 race/ordinal-fold tests passed with the explicit
  contract changes described above.
- Final Linux build plus both full suites ran in one joined background job,
  with OPENCODE_DB unset and fresh HOME. Build passed (three package builds;
  nine generated TUI files unchanged). Full suites remain baseline-red: plugin
  7,512 pass / 19 skip / 33 fail across 7,564 tests; Pi 1,654 pass / 9 skip /
  144 fail across 1,807 tests. Every one of the 177 final named failures is in
  the previously verified baseline: `evidence/message-final-comparison.json`
  has both difference sets empty. These are not green full-suite gates.
- An earlier separate build/test job had nine additional missing-dist-entrypoint
  bundle failures; building and testing in one job removed those failures.
  The three newly affected adoption expectations were corrected explicitly,
  rather than treating them as unrelated baseline failures.
- TypeScript 5.9.3: Pi and plugin package typecheck scripts passed. A temporary
  Pi-derived configuration also typechecked the new message tests and both
  host scripts directly; retained as `message-final-typecheck-config.json`.
- Biome 2.5.1: ten changed source/test/probe files passed, with 33 non-fatal
  test/probe warnings and no production-source warnings. AFT inspection remained
  partial and included stale old-storage-API diagnostics; fresh CLI typechecks
  are the authoritative results.
- Five new staged-index mutation controls each failed only its named test while
  a positive control stayed green: all-branch indexing, missing message-cache
  proof, omitted queue retargeting, omitted whole-message fingerprint proof,
  and omitted returned-array digest comparison. Every applied stat was non-empty
  and every restore-plus-touch stat was empty. Named output and stat pairs are
  retained in `evidence/msg-mutation-*.txt` and `.stat`; the delivery enumerates
  those controls. The original tool controls remain documented in the earlier
  commit's delivery.
