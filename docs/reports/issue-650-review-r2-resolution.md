# Issue 650: resolution of the second review (r2)

Base: `e5eb333b` (the 650 fix plus `issue-650-review-r2.md`). The ruling for
this round:

> No tag-identity conflict may refuse more than one turn. A proven byte-safe
> survivor is kept with no byte change. When none can be proven, the declared
> one-time repair applies (newest number kept, one `tag_identity_repair`
> rebuild), whether or not a last served array is in memory. If the same
> identity recurs after its repair, the pass still serves, without a second
> repair, and records a recurring-identity event. The only refusals left are
> the fit and storage refusals.

All six r2 `test.failing` tests are ordinary passing tests now. Tests whose
assertion the ruling changed say so in a comment (listed at the end).

## Finding 1: cached-proof failure no longer blocks the repair

- `adoptPiFallbackTags`'s `plan` no longer reads the last served array. Proven
  (a cached survivor, or exactly one served number): fold with no byte change.
  Unproven: the one repair, claimed under the once guard. A cached array that
  proves nothing is no better evidence than a missing one.
- Both cached matchers count only numbers **rendered as tags**
  (`piRenderedTagNumbers` in `pi-tool-identity.ts`): the leading `§N§` of a
  text part or string content, a leading `[dropped §N§]` / `[truncated §N§]`
  placeholder, and the dropped-input placeholder inside tool-call arguments.
  This is sound because Magic Context writes tags only there and `prependTag`
  strips any leading tag notation before writing its own, so a number in a tag
  position is the number decorating that part. Any other `§N§` is text written
  by a tool or the model (the ctx_reduce receipt `Queued: drop §8§.`, a reply
  quoting a tag), which says nothing about which number this call or message
  carries. A number rendered as a tag elsewhere still vetoes the proof.
- `piCachedMessageSurvivor` matches the served message by header (response id,
  timestamp, role, tool call id) and requires the candidate number as the
  leading tag of the same text part. It no longer compares content: Magic
  Context rewrites served text (stripped reminders, reasoning or caveman
  rewrites), so a content comparison failed for exactly the messages it had
  changed. The rendered number already ties the part to one of this identity's
  candidate rows.

## Finding 2: the fold's protection has its own flag

The survivor's target now carries `identityRepairProtected` (new optional
`TagTarget` field) instead of `thinkingDropProtected`. Drops are still withheld
on that pass (protected tag set, inert drop methods, and the Pi heuristic
injection-drop check), but the pending flush signal is consumed on the flush
pass, so the next scheduler-deferred pass serves the same bytes.

## Finding 3: position-independent fallback ids

- `piContentFallbackIds` (`read-session-pi.ts`) gives a message with no real
  entry id `pi-msg-c<16 hex>o<occurrence>-<ts>-<role>`: a digest of header and
  content, plus a counter for exact duplicates in the same array. It is
  computed once per pass in `runPipeline` from the input array, before any
  stage edits content; `stableIdResolver` and the post-commit stable-id map
  read it by index (nothing splices the array before those maps).
- The `<ts>-<role>` suffix keeps the shape `parsePiFallbackToolOwnerId` reads;
  the parser accepts both forms. Order-based twin pairing reads the occurrence
  counter for the new form and the index for the old form, never a mix.
- Message adoption re-keys rows stored under the old index-bearing form to the
  message's new fallback id, number unchanged (as tool owners already were),
  when exactly one message of the pass, and no real entry, carries that
  fingerprint.
- Unchanged on purpose: `resolvePiStableId`'s own lane 3 still makes the
  index form. Its other callers (thinking recovery, provider-error recovery,
  compartment boundaries, the legacy placeholder path) are self-consistent and
  do not key tags.

## Finding 4: lane switch keeps the header mapping

When the anchored lane gives up (anchors out of order) and the fingerprint lane
runs, `fillPiEntryIdsByUniqueHeader` gives each still-unresolved message the
entry its header names, if exactly one emitted entry carries that header and no
other message took it. The positional and anchored lanes identify the message
by that same header, so the id no longer depends on which lane the pass took.

## Finding 5: position-independent once-guard key

The tool repair key is `["tool", <owner timestamp>, <call id>]`, the identity
adoption already matches on, instead of the owner id (index-bearing for an
unresolved owner). The owner-id key earlier builds wrote is still honoured.
Message keys are `["message", <target id>:pN]`; the target is a real id or a
position-independent fallback id.

## Finding 6: attribution

`classifyCacheBust` has `accounted_tag_identity_repair` for
`materialize_reason=tag_identity_repair` (both materialized and not), with a
rule-table row, a fixture row and the sentinel's doc table. The dashboard's
`transform_decision_reason_label` names it "Tag identity repair". The missing
`host_compaction` label noted in r2 is pre-existing and left alone.

## No identity refusals

- The allocation guards (`guardPiToolAllocations`, `guardPiMessageAllocations`)
  return what they cannot resolve; the pass logs it once per identity
  (`tag identity unresolved: …`) and tagging allocates as it did before the
  guards existed: one cache change.
- A recurrence after the repair leaves the rows unmerged, records a
  `tag-identity-recurring` decision once and logs `tag identity recurred after
  its one repair: …`.
- A decision ledger too full for the guard or the pending-rebuild record serves
  the duplicate unmerged; a fold whose rebuild record cannot be written is
  undone inside its savepoint, so bytes never change without a declared
  rebuild.
- A damaged pending-rebuild record is ignored rather than refusing.
- Low-level `adoptPiFallbackTags` without `allowUnprovenRebuild` still fails
  closed, as before. That is why `issue-640-review-r2.test.ts`'s `three-row
  unserved ordinal collision … refuses without changing any row` is unchanged:
  it calls adoption without that option. The production pipeline passes it, so
  the same never-served state there takes the one repair (pinned by the r2
  test `never-served duplicates must not refuse just because a served array is
  in memory`).

## Field-evidence scenarios

The alignment differential's `issue-650` scenario gained passes 8-13: an Oh My
Pi request-built note that is not a branch entry, an event-only custom message
ahead of it (index shift), a message whose event copy has more content than its
entry, a persisted custom message emitted out of order (fingerprint lane), a
pi-rewind `/rewind` (branch summary) landing right after the note, and an
append. Each line now shows `repairs`, `recurring`, `unresolved`, and the note's
and rewritten message's numbers; the test asserts, for each event shape (pi087 and systems), exactly one repair,
no recurrence, and one number each for the note and the rewritten message. On
the base build's product code the same script refuses with the message-tag
guard. The `default` and `kept-duplicates` scenarios print identical lines on
the base build and on this change.

## Tests whose assertion changed

Each first asserted a refusal that the ruling replaces with a served result:

- `issue-650-review-r2.test.ts`: the two finding-5 tests (now "served without a
  second rebuild"); the finding-6 partner (both states now name the repair).
- `issue-650-review.test.ts`: the real host runner test now serves an
  unprovable conflict with one repair.
- `issue-650-recovery.test.ts`: the reintroduced conflict serves with no second
  repair; the timestamp-less orphan guard test expects a report.
- `issue-650.test.ts`, `issue-650-message.test.ts`,
  `issue-650-identical-pair.test.ts`: guard tests expect a report; the
  message evidence matrix moves `both-cached` and `wrong-fingerprint` to the
  proven side and adds `both-rendered` and `wrong-header` as refusing cases.

## Rebase onto master `977a3d8f`

- Fallback ids and the raw-ordinal offset are separate. The offset numbers
  `RawMessage.ordinal` for branch entries read from the session store
  (historian, search index, ctx_expand); those messages always carry their
  real entry id. The position-independent fallback ids name only context-event
  messages that have no entry, and are used only for tag keys inside a
  transform pass. Neither reads the other.
- The OpenCode stall fix's tag-identity write classifier (`mayChangeTagIdentity`
  in `shared/sqlite.ts`) treats any `UPDATE tags` that assigns `message_id` or
  `tool_owner_message_id` as an identity write, since neither column is in its
  identity-free list. The re-key of an old index-bearing row to its new id is
  such an update; `issue-650-r3.test.ts` pins that it advances the
  identity-write generation.
- The checkout-claim removal dropped the claim branch from the Pi refusal
  notice; the identity-conflict branch stays.

## Third review (`issue-650-review-r3.md`): seven findings

All eleven `test.failing` witnesses in `issue-650-review-r3.test.ts` are now
ordinary tests.

1. **Failed decision writes.** Every identity-decision write goes through one
   contained helper (`freezeIdentityDecision` in `pi-tag-identity-repair.ts`):
   any exception, not only a busy store, returns "not written". The planner
   then serves the duplicate unmerged; the fold's savepoint is undone on any
   failure with production options and the turn is served with the rows as
   they were. A byte-safe proven fold also stays unmerged when the guard
   cannot be written or the identity is already recorded as served unmerged,
   so rows do not flip between turns.
2. **Damaged outer ledger.** `readPiIdentityDecisions` returns null (logged
   once per session) for a field that is not JSON, not an array or has a
   non-string member. Identity decisions then serve unmerged; the
   reminder-strip and seam-strip replays read through it too and replay
   nothing. Nothing writes the field while it is unreadable: every write path
   reads it first and stops, and the rebuild acknowledgement validates the
   array and writes only with a compare-and-set on the exact old value. The
   damaged value, which may still hold other decisions, is left untouched.
3. **Dropped message proof.** `piCachedMessageSurvivor` accepts a dropped row
   whose served part is exactly `[dropped §N§]`, like the tool proof, so the
   dropped number is kept with no rebuild and the dropped content stays off
   the wire.
4. **Identical unsaved messages.** `settlePiFallbackOccurrences` (in
   `runPipeline`) checks the stored occurrences of each content digest. When a
   copy has disappeared, the survivors take the stored occurrences with the
   newest numbers instead of shifting into the vanished copy's id; the change
   is declared once per digest as a `tag_identity_repair` rebuild (guard
   `["message-occurrence", <digest>]`) and later passes keep the same choice.
5. **Message guard key.** The message once guard is `["message",
   <fingerprint>, <part ordinal>]`, so it survives the move from a fallback id
   to a real entry id; the target-id key earlier builds wrote is honoured. The
   pending rebuild record keeps its per-target key.
6. **Dropped-input placeholder.** Only tool-call arguments that are exactly
   `{ dropped: "[dropped §N§]" }` count as a rendered tag.
7. **Recurrence with a full ledger.** `recordPiIdentityRecurrence` returns
   whether to log: true when it wrote the record, or once per process,
   session and identity (an in-memory set) when it cannot. Recurrence records
   may use a small reserved allowance beyond the ledger cap
   (`PI_IDENTITY_RECURRENCE_ALLOWANCE`, 64), so a full ledger still records
   the recurrence the review's witness expects; past that allowance only the
   log fires, once.

The served-number JSONL fence is unchanged: a failed identity publication
still refuses, as the review recommends.
