# Issue 650 fix: correctness review

Reviewed commit `9ce293ecdb` ("preserve Pi tool tag identities for issue 650") against
base `691725deaa`. No product code was changed. The probes are in
`packages/pi-plugin/src/issue-650-review.test.ts`. A `test.failing` test records a
finding: it asserts the behaviour this review expects and fails today. Each one has a
passing partner test that pins the current behaviour, so the expected failure cannot
come from a broken fixture.

## Verdict

**Merge, but do not close #650 and do not tell the reporter the session repairs itself.**
The change never shows the model a different tag number or status than it was last
served. It stops the allocation that minted the second number, and it replaces the
misleading storage-busy text for tool-tag conflicts. Every finding below is about
liveness or completeness, not byte safety:

- the reporter's realistic state still refuses forever (F1);
- the follow-up message-tag conflict from the issue's second comment still says
  "storage is busy; send your message again" (F2).

| Area | Verdict |
| --- | --- |
| 1. Survivor selection | Byte-safe in all 64 combinations. Incomplete: 10 combinations refuse even though a byte-safe fold exists, including the reporter's realistic state (F1). |
| 2. Self-repair safety | Sound. It cannot change a served byte, merge two calls, or change tail bytes on a defer pass. The cached-byte evidence cannot be borrowed from a twin call. |
| 3. Owner matching (`pi-tool-identity.ts`) | No merge of distinct calls found. Same-args twice, a retry that reuses the call id, and cloned entries all stay separate. Liveness note N1. |
| 4. Refusal | Correct for tool-tag conflicts through the real handler and host runner. Storage-busy wording is unchanged. Gap: message-tag conflicts (F2). |
| 5. Tightened fixtures | Tightened, not weakened. One assertion became a precondition echo, and the claim it used to carry is now pinned as a refusal. |

## 1. Survivor selection

`adoptPiFallbackToolOwnerTag` (`packages/plugin/src/features/magic-context/storage-tags.ts:1780-1862`)
uses these names: `f` is the fallback row (`survivor` in the code, tag 154 on a
`pi-msg-` owner), `r` is the real-owner row (`existing`, tag 8), `S` is the cumulative
served-number ledger, and `c` is the number proven by cached bytes (`cachedSurvivor`).

- Throw if both `f` and `r` are in `S` and `c` is neither of them (`:1821-1831`).
- Keep `f` when `c === f`. When `c` is undefined, keep `f` when `f` is in `S`. Otherwise keep `r` (`:1832-1837`).
- Throw if the kept row was served or cached, is active, and the removed row is dropped (`:1838-1846`).
  Without this rule, `foldDuplicateIntoSurvivor` → `applyDroppedStatusIfNeeded` (`:1440-1453`)
  would copy the loser's dropped status onto served active bytes.
- In the context handler, a duplicate that is neither in `S` nor cached refuses before
  the storage call (`packages/pi-plugin/src/context-handler.ts:2479-2488`).

The test `storage survivor matrix never changes the last-served number or status` covers
every combination of fallback status × real status × served set (`{}`, `{154}`, `{8}`,
`{8,154}`) × cached survivor (none, 154, 8), 64 cases in all. "Last served" means the
cached number when there is one; otherwise it is the single number in `S`. Where the
code does not refuse, the surviving row always has that number and its unchanged
status, and a duplicate whose last-served number is unknown always refuses. **No case
changes a served byte.** The test also pins the exact list of the 10 refusals that have
a byte-safe alternative: in each one, the last-served survivor is active and its
duplicate is dropped. Keeping the survivor unchanged, without copying the drop, would
leave every byte identical.

### F1: the reporter's realistic state is not repaired (liveness)

Tag 8 was served as `[dropped §8§]`. A later pass lost the real owner and minted 154.
Because 154 is active, that pass served `§154§ <output>`. Every pass after that either
served 154 again or reached adoption and refused. **So the last-served (cached) bytes
carry 154, active, not 8.** Both numbers are in `S`, as the logged "Conflicting served"
line confirms.

- If an LKG matching the last served digest is present, `piCachedToolSurvivor` proves
  154. Adoption then refuses with "a duplicate's dropped status would change the served
  tool bytes". Pinned by `realistic reporter state — cached bytes prove 154 active, and
  adoption still refuses`. Recorded as a finding by `test.failing`
  `realistic reporter state should self-repair to the served 154 active row`.
- If the LKG is missing (the reporter's log shows `lkg_miss`), adoption refuses with
  "no byte-safe cached survivor is proven". Pinned by `reporter state after a restart
  without an LKG ... refuses`.

The worker's report says that **8 survives** "when 8 is the sole evidenced served number
or exact current cached bytes prove it". That condition is true, but neither part holds
for the reporter's incident, and its own fixtures (`historical-both`, `restart`) seed
cached `[dropped §8§]` bytes, which the reported mechanism cannot produce. The
reporter's manual repair (keep 8, dropped) did change bytes against the last served
array, from `§154§ …` to `[dropped §8§]`. It works as a single cache bust; it is not
byte-identical.

Suggested fix, not implemented here: when the kept row is the proven last-served active
row and the duplicate is dropped, fold with `propagateDroppedStatus = false`. The
parameter already exists on `foldDuplicateIntoSurvivor`. Optionally, re-queue the drop
as a pending operation, so it runs on the next execute pass instead of changing bytes
now. Sessions without LKG evidence still need a supported repair command, because a
resend can never fix them.

## 2. Self-repair safety

- **Served bytes.** The kept number is always the cached number, or the only number in
  `S`. Proven cached bytes contain exactly one candidate number (`present.length === 1`,
  `pi-tool-identity.ts:82-86`), so the removed number appears nowhere in the last-served
  array. Status changes on a served or cached survivor refuse. Queued operations move to
  the survivor and run only on an execute pass. A defer pass therefore produces
  identical bytes. The worker's test `recovery and subsequent defer passes replay
  identical dropped tool bytes` shows this for the `c = 8` shape, and every other shape
  refuses.
- **Digest-correlated evidence** (`piCachedToolSurvivor`, `pi-tool-identity.ts:44-105`).
  The SHA-256 of `getSlot(sessionId).jsonPrefix` must equal the last returned-array
  digest: the in-memory value from `capturePiServedArray`, or the last line of the
  durable digest ledger (`served-array-ledger.ts:122-146`). `getSlot` reloads the
  persisted LKG after a restart (`lkg-slot.ts:564-577`). The cached array must hold
  exactly one assistant owning the call id, with the fallback row's timestamp and
  exactly one matching call. That call's own `toolResult` must render the winner as
  `§N§ …` (active) or exactly `[dropped §N§]` (dropped), and that must agree with the
  row's status.
- **Two calls with identical content cannot fool it.** These tests confirm it: a call id
  reused across two cached assistants yields no survivor (`a reused call id in the
  cached bytes cannot prove a survivor`). An identical twin call's number vetoes the
  proof and cannot stand in for the call's missing result (`an identical twin call's
  result vetoes…`). Evidence from an assistant with a different timestamp is rejected
  (`cached evidence is bound to the fallback row's timestamp`).
- **Residual risk (low).** Digest records are flushed 25 ms later and dropped if the pass
  stopped being current (`served-array-ledger.ts:261-286`). If both the LKG and the
  digest for the newest served pass were lost, an older matching pair could serve as
  evidence. That older pair can only disagree with the newest bytes through a status
  change, which the status cross-check rejects, or through a newly minted number, which
  the allocation guard now prevents.
- **Merging different calls.** Adoption pairs rows by `(timestamp, callId)`, and only
  when exactly one owner matches in the current context (`context-handler.ts:2454-2459`).
  The cached evidence is bound to the same timestamp, so distinct invocations are never
  folded together.

## 3. Owner matching in `pi-tool-identity.ts`

The identity is `JSON.stringify([assistant.timestamp, ordered toolCall ids])`. It is used
only when the exact content fingerprint is missing, and only when its bucket holds
exactly one entry that has not been consumed (`context-handler.ts:1741-1762`). Results
from the tests:

- `the same tool with the same arguments called twice keeps two owners and two tags`:
  both are prose-edited with framing added, resolve to `a1`/`a2`, and get two tool tags.
- `a retried call that reuses the call id stays a separate invocation`: the same call id
  at a new timestamp resolves to separate entries and gets two distinct tags.
- `two branch entries sharing timestamp and call ids are never merged by tool identity`:
  both slots stay unresolved.

Separate entries could only merge if two different assistant entries had the same
millisecond timestamp and the same ordered call ids. No real host produces that.

**N1 (liveness, not a merge).** If an extension changes the assistant's timestamp or its
call-id vector, for example by removing one of two calls, the identity misses.
`guardPiToolAllocations` (`context-handler.ts:2194-2237`) then refuses wherever the old
code minted a second tag. That is the correct trade-off, but such an extension blocks
every turn. The guard also runs `db.prepare` once per tool call on every pass while any
`pi-msg-` tool row exists. Rows without a timestamp are never adopted, so this can be
permanent. It is a minor cost.

## 4. The refusal

- Identity conflicts skip storage-busy handling, LKG replay and raw fall-through
  (`context-handler.ts:4616-4621`). The guarded hook detects the typed error anywhere in
  the `cause` chain (`pi-context-refusal.ts:95-100`), aborts, and records
  `Magic Context tool-tag identity conflict: … resending alone will not repair it.
  stage=… elapsed=…ms recovery=…`.
- `the real context handler refuses a tool identity conflict with its own message` runs
  the real `registerPiContextHandler` through Pi's installed `ExtensionRunner`. It
  covers the reporter rows with no LKG and checks abort, a single entry, the identity
  wording, no storage-busy or resend wording, and unchanged rows.
- `a storage-busy refusal keeps its retry wording` confirms that the other path is
  unchanged. Checkout-claim refusals keep their own message (same branch, `:98-99`).
- Raw history: as with every refusal, the hook returns `event.messages` after
  `ctx.abort()` (`:254-256`). The abort is what prevents dispatch. This predates the
  change, and so does one OMP-only gap: OMP side turns do not abort (`:111`). Behaviour
  change: with compaction off, an identity conflict now refuses where it used to fall
  through to raw input. That matches "never send raw history".

### F2: the message-tag conflict from the issue's second comment still says "storage busy"

`adoptPiFallbackMessageTag` still throws a plain `Error("Conflicting served Pi message tag
numbers; refusing identity adoption")` (`storage-tags.ts:1910`). The handler wraps every
other failed pass in `PiStorageBusyError` (`context-handler.ts:4706-4714`), so the
reporter's second incident would still show "Magic Context storage is busy; send your
message again". Pinned by `a served message-tag conflict (issue comment 2) is still not
an identity refusal`, and recorded as a finding by `test.failing` `a served message-tag
conflict should refuse as an identity conflict`. The `PiTagIdentityConflictError` text
is hard-coded to "tool-tag", so it needs a kind parameter before the message path can
reuse it.

The fix now builds the transcript ids and the adoption ids with the same resolver
(`args.messages.map(stableIdResolver)`). This may remove one way the duplicate message
tags in that comment could have been created. That is not proven, and the message-tag
survivor rule is unchanged.

## 5. The tightened collision fixtures

The fixtures are in `packages/pi-plugin/src/context-handler.test.ts`, in the "Pi fallback
tag adoption" block.

- **`retargets pending ops on collision…`** and **`retargets a duplicate-only pending
  op…`**: the old setup had no served evidence and expected a fold to the real row. The
  new setup records the real number as served and keeps every assertion. Their original
  shape now refuses, which is pinned by `the collision fixtures' original unserved shape
  now refuses instead of folding`. Requiring served evidence is the right reading.
  `S` is written synchronously and a write failure refuses the turn, but `S` only starts
  at v0.47.0 (`21d5aabc02`). Older sessions cannot prove that a number was never served.
  This costs liveness for pre-0.47 duplicates, which used to fold silently. The comment
  at `storage-tags.ts:1854-1855` ("Without served evidence either identity is safe") no
  longer describes what the handler does.
- **`folds tool-owner collisions … max accounting and alias rebinding`**: the max
  accounting, source retention and tagger rebinding assertions are unchanged. Its
  `status: "dropped"` assertion used to prove that a dropped duplicate carries its drop
  onto the survivor. Now the survivor is set to dropped beforehand, so the assertion only
  echoes the setup. Mutation check: forcing `applyDroppedStatusIfNeeded` to return early
  left all 13 "Pi fallback tag adoption" tests green, and nothing in
  `served-collision.test.ts` or `migrations-v86.test.ts` turned red. The same file's other
  failures were the 8 pre-existing historian/auto-search ones. This is not a weakening
  of reachable behaviour: in the context-handler path every "active survivor + dropped
  duplicate" case now refuses, so carrying the drop over cannot happen there. The
  replacement claim is pinned by `the accounting fixture's original status shape (served
  real active, dropped fallback) now refuses`. Under F1, that refusal is also one of the
  10 cases where a byte-safe fold exists.

## Gates (Linux, Bun 1.4.2, `OPENCODE_DB` unset, throwaway `HOME`)

- `bun test src/issue-650-review.test.ts`: 16 pass, 0 fail.
- `bun run build`, then `packages/pi-plugin` `bun run test`: 1653 pass, 9 skip, 144 fail.
- `packages/plugin` `bun run test`: 7512 pass, 19 skip, 33 fail.
- These are the worker's recorded totals (1637/9/144 and 7512/19/33) plus this file's 16
  passes. No failure is in an issue-650, adoption, collision or refusal test. The
  failures are status-dialog, ctx_note, historian and memory tests.
- Biome 2.5.1 `check` on the new test file: clean.
- TypeScript 5.9.3, with a temporary config that includes the new file: no errors in
  it. The only error is the pre-existing one at `pi-context-host.test.ts:76`.
