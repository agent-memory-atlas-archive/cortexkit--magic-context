# Issue 650: third independent correctness review

Reviewed `5290e11bdee377b4624dbce8dad2979289002c23` (round 3, rebased onto master `977a3d8f`), including issue 650 and all nine comments, the first two review reports, and `issue-650-review-r2-resolution.md`. This delivery changes **tests and this report only**, not product code.

## Verdict

**The ruling is not fully implemented.** Ordinary Pi and OMP reporter-shaped turns now serve, the six second-review reproductions pass, and the ordinal-offset rebase and identity-write generation are preserved. Seven additional defects remain. Two can repeatedly refuse an identity-conflicted turn, two lose the proven/previously active message identity, and one allows a second repair of the same message after fallback-to-real adoption.

| # | Severity | Finding | Failing witnesses |
|---|---|---|---|
| 1 | High | A non-busy failure writing either the once guard or pending rebuild aborts every attempt | 2 |
| 2 | High | A damaged outer content-decision ledger aborts every attempt | 3 |
| 3 | High | A cached dropped **message** is not accepted as proof; the request resurrects it under a different number | 2 |
| 4 | High | Removing the first identical unsaved message transfers its dropped identity to the surviving second message | 1 |
| 5 | Medium | A repaired fallback message gaining a real entry ID can receive a second repair | 1 |
| 6 | Medium | A `[dropped §N§]` quote inside ordinary model tool arguments vetoes a proven survivor | 1 |
| 7 | Low | A full decision ledger neither records recurrence nor limits its log to once | 1 |

Severity refers to demonstrated behavior, not a claim that these states caused either reporter's session. No private transcript or live database was available or accessed.

## Executable reproductions

All new unit witnesses and their positive partners are in:

`packages/pi-plugin/src/issue-650-review-r3.test.ts`

`finding` selects `test.failing` normally and ordinary `test` when `ISSUE_650_EXPECT_RED=1`. This exposes the exact broken assertions without editing product code or weakening the passing partners. A repaired implementation produces an unexpected pass in the normal expected-failure run, requiring the witness to be promoted to an ordinary test.

Use an isolated root, including for the unit runner:

```sh
ROOT="${TMPDIR:-/tmp}/magic-context/issue-650-r3-repro"
mkdir -p "$ROOT"/{home,data,config,state,runtime,agent,storage}
export HOME="$ROOT/home" XDG_DATA_HOME="$ROOT/data" \
  XDG_CONFIG_HOME="$ROOT/config" XDG_STATE_HOME="$ROOT/state" \
  XDG_RUNTIME_DIR="$ROOT/runtime" OPENCODE_DB="$ROOT/opencode.db" \
  MAGIC_CONTEXT_STORAGE_DIR="$ROOT/storage" PI_CODING_AGENT_DIR="$ROOT/agent"
cd packages/pi-plugin
BUN_JSC_useOMGJIT=0 bun test src/issue-650-review-r3.test.ts --max-concurrency 4
# Expose assertion failures instead of accepting test.failing:
ISSUE_650_EXPECT_RED=1 BUN_JSC_useOMGJIT=0 \
  bun test src/issue-650-review-r3.test.ts --max-concurrency 4
```

Add `--test-name-pattern '<the name below>'` to isolate any witness. The initial exposed run had **8 passing partners / 10 failures**; the subsequently added unsaved-note pair had **1 pass / 1 failure**. The full package run includes all 20 new tests (9 partners, 11 expected failures). The failures are assertions about real outputs, not setup exceptions accepted by `test.failing`.

### 1. High: failed guard/pending writes still cause repeated refusals

**Source:** `packages/plugin/src/features/magic-context/pi-content-decisions.ts:116-120`, `packages/pi-plugin/src/pi-tag-identity-repair.ts:32-51,80-92`, and `packages/pi-plugin/src/context-handler.ts:3237-3257`.

The storage helper returns `false` only for busy/locked errors; every other error escapes. The repair planner handles a returned `unpersisted`, and the fold handles `PiIdentityRebuildUnrecorded`, but neither handles a persistence exception. Thus a failure limited to the repair records still rolls back preparation rather than serving the duplicates unmerged.

**Exact reproduction:** in the in-memory migrated test DB, insert tool tag 8 on owner `real` and tag 154 on `pi-msg-1-20-assistant`, both for call `call`. Put both in the cumulative served-number set and clear the cached array. Install a SQLite trigger which rejects **only** an update containing the selected repair-decision kind:

```sql
CREATE TRIGGER fail_identity_decision
BEFORE UPDATE OF merged_reasoning_stripped_ids ON session_meta
WHEN NEW.merged_reasoning_stripped_ids LIKE '%tag-identity-repair-once%'
BEGIN SELECT RAISE(FAIL, 'injected decision write failure'); END;
```

Repeat with `tag-identity-repair-pending`. Invoke the real registered context handler three times with the same four messages and real owner `real`. Both cases refuse **3/3 turns** (`expected <= 1`, `received 3`). The trigger does not prevent tag writes, session metadata writes unrelated to that column, or served-array publication. This is not a simulation of a completely unwritable database.

**Witness names:**

- `review 650 r3 finding: failed tag-identity-repair-once write must serve unmerged rather than repeatedly refuse`
- `review 650 r3 finding: failed tag-identity-repair-pending write must serve unmerged rather than repeatedly refuse`

**Passing partners:** `review 650 r3 partner: an intact ledger serves three turns with one repair`, plus both `review 650 r3 partner: a busy <kind> write leaves rows unmerged without refusing` tests. The latter trigger the recognized `database is locked` error instead and preserve both rows without declaring a repair.

### 2. High: damaged outer decision records still cause repeated refusals

**Source:** `packages/plugin/src/features/magic-context/pi-content-decisions.ts:39-58`, called by `readPiIdentityRebuilds` at the start of adoption (`context-handler.ts:3162`).

The pending-record reader catches malformed **inner repair JSON**, but `getPiContentDecisions` first parses the outer session-meta field without containment. Non-JSON, a non-array, or a non-string array member throws before any repair/recurrence decision can be made.

**Exact reproduction:** use the same tool duplicate and real context-handler fixture as finding 1. Replace `session_meta.merged_reasoning_stripped_ids` with each of:

1. `not-json`
2. `{"decisions":[]}`
3. `[17]`

Three consecutive attempts each refuse **3/3 turns**. No raw message, tag mapping, or SQLite lock changes between attempts.

**Witness names:** `review 650 r3 finding: damaged outer ledger <value> must not repeatedly refuse an identity conflict` (one test per value).

**Passing partners:** the intact-ledger partner, and `review 650 r3 partner: damaged pending payload is ignored and three turns are served`. The latter keeps a valid outer string array and adds a pending decision whose payload is `{broken`; it serves three turns. Containment of damaged pending payloads is real, but does not cover the containing ledger.

### 3. High: the cached dropped-message proof is rejected and the message is resurrected

**Source:** `packages/pi-plugin/src/pi-message-identity.ts:87-96` accepts only `status === "active"` and a leading `§N§ ` tag. The shared rendered-tag parser recognizes a leading dropped sentinel, and the tool proof accepts dropped results, but the message proof does not.

**Exact reproduction:** insert `real:p0` tag 20 with dropped status and `pi-msg-0-1-user:p0` tag 440 active, with identical fingerprints and source text `original source`. Record both historically served numbers. Cache exactly:

```text
user(timestamp=1): [dropped §20§]
assistant(timestamp=2): §441§ prior
user(timestamp=3): §442§ next
```

Adopt onto `real`. Instead of retaining dropped 20 with no rebuild, the implementation removes 20, keeps **active 440**, and declares an unproven repair. Driving the real context handler returns `§440§ original source` where the last served array had `[dropped §20§]`. A recovered drop is deferred, so previously dropped user content is actually present on this turn. This is a wrong survivor despite direct tag-position evidence, not merely an additional log line.

**Witness names:**

- `review 650 r3 finding: a cached dropped message must keep proven 20 without rebuilding to 440`
- `review 650 r3 finding: a proven dropped message changes cached bytes on the next turn`

**Captured failure:** expected `{tag_number:20,status:"dropped"}`, received `{tag_number:440,status:"active"}`; expected cached user content `[dropped §20§]`, received `§440§ original source`.

**Passing partner:** `review 650 r3 partner: an active cached message keeps the older proven number, not newest 440`. The only relevant change is that the cached/source row is active, and it keeps 20 without a rebuild.

### 4. High: fallback occurrence numbering aliases a surviving identical message after removal

**Source:** `packages/pi-plugin/src/read-session-pi.ts:167-231`, particularly the per-array occurrence counter. Exact duplicate fallback IDs are distinguished by `o0`, `o1`, etc.; the occurrence number is recalculated from the currently visible array.

**Exact reproduction:** the saved branch contains only `hello`. Serve two separate unsaved user messages, each with content `host-built note` and timestamp 7, followed by `hello`. They get distinct tags 1 and 2. Mark the **first** row dropped. Rebuild the input with only the **second** message and `hello`, as can occur when a host rebuilds/rewinds context. No stable entry ID becomes available. The remaining message now receives the `o0` fallback ID formerly belonging to the deleted first occurrence.

**Witness:** `review 650 r3 finding: removing the first identical unsaved note must not transfer its dropped tag to the second`.

**Captured failure:** expected the surviving message's already-served `{role:"user",content:"§2§ host-built note",timestamp:7}`; received `{role:"user",content:"[dropped §1§]",timestamp:7}`. This is identity reuse between different logical messages, even without an SQL duplicate-fold operation.

**Passing partner:** `review 650 r3 partner: removing an unrelated unsaved note does not change the surviving note`. Make the second note's text different; it retains its exact prior served message.

**Boundary:** absent saved IDs, two byte-identical messages cannot be distinguished from their current single-message payload alone. That is a reason to treat the historical correspondence as ambiguous, not proof that the first occurrence's drop belongs to the surviving second message. This test does not claim the OMP reporter supplied identical notes; it exposes a wrong-alias consequence of position-relative duplicate occurrence numbering.

### 5. Medium: message repair guards follow the changing target ID, not the message

**Source:** `packages/pi-plugin/src/context-handler.ts:3322-3324` constructs the message guard as `["message", realContentId]` with no legacy keys. The tool path, in contrast, uses timestamp/call ID and honors an old owner-based key (`3535-3545`).

**Exact reproduction:** create one unmatched note (`host-built context note`, timestamp 7). Seed its legacy index-based fallback row as tag 20 and its current content-based fallback row as 440. Put both in the historical served set, with no cached body. Adoption onto the content fallback keeps 440 and records its once guard and pending rebuild. Acknowledge that pending rebuild, as after serving the repaired request. A faulty/older writer then creates `real:p0` tag 600 with the same fingerprint; the saved real entry becomes resolvable. Add 600 to served history, still without a last-served body, and adopt the fallback onto `real`.

**Witness:** `review 650 r3 finding: a repaired fallback message gaining a real entry id must not buy a second rebuild`.

**Captured failure:** a second pending rebuild `{key:'["message","real:p0"]', kept:600, removed:[440], kind:"message"}` rather than recurrence. The first guard was keyed to the content fallback ID, so it is never consulted. The two rebuild records concern the same fingerprint/part and same logical message, not two parts of a message.

**Passing partner:** `review 650 r3 partner: a recurring message with the same fallback key gets no second repair`. Reintroducing the third row under another legacy index fallback while retaining the content fallback target correctly leaves it unmerged and records recurrence.

### 6. Medium: a dropped receipt quoted inside tool arguments is treated as a rendered tag

**Source:** `packages/pi-plugin/src/pi-tool-identity.ts:43,75-83`. The parser serializes the entire argument object and scans every substring matching `[dropped §N§]`. It does not require an actual dropped-input placeholder value.

**Exact reproduction:** seed the two active tool rows 8/154 and cache a request whose result is `§154§ 1`, with one matching assistant call at timestamp 20. Let that call's ordinary code argument be:

```js
{ code: "console.log('[dropped §8§]')" }
```

Both candidate numbers are now counted as rendered: 154 really decorates the result, while 8 is only a quoted string in model-authored code. The cached proof is vetoed, so adoption declares `tag_identity_repair`, keeps 154, and removes 8. The rebuild is unnecessary on this cache-preserving input. The current witness keeps the already-newest survivor; choosing a wrong older/newer survivor is not needed to demonstrate the false proof veto.

**Witness:** `review 650 r3 finding: a dropped receipt quoted inside model arguments must not trigger an unproven repair`.

**Captured failure:** expected `outcome.rebuilds=[]`; received one tool repair keeping 154 and removing 8.

**Passing partner:** `review 650 r3 partner: a bare tag quote in model arguments does not veto the proven tool survivor`. Change only the code string to `console.log('§8§')`; cached proof keeps 154 without a rebuild. The earlier second-review tests also verify that an ordinary `Queued: drop §8§.` tool-result receipt no longer vetoes proof. The remaining hole is the special dropped-sentinel regex inside model arguments.

### 7. Low: a full ledger cannot record recurrence and logs it repeatedly

**Source:** `packages/pi-plugin/src/pi-tag-identity-repair.ts:64-67`. `recordPiIdentityRecurrence` returns `true` even if `freezePiContentDecision` returned `false`. The caller interprets that result as “fresh” and logs once per adoption attempt. A failed pending-rebuild record likewise queues a fresh log without recording recurrence (`context-handler.ts:3254-3257`).

**Exact reproduction:** fill all 4096 decision slots with retained repair-once decisions, seed the unproven tool duplicate, and invoke production-options adoption three times without capturing any returned array between attempts. Every attempt leaves both rows intact (correct liveness), writes no recurrence record, and logs `tag identity recurred after its one repair...` again.

**Witness:** `review 650 r3 finding: a full ledger must record and log recurrence once, not on every turn`.

**Captured failure:** expected one recurrence log, received three; the persisted recurrence reader returns no entries.

**Passing partner:** `review 650 r3 partner: full and one-free-slot ledgers serve duplicates without an unrecorded repair`. Both capacity boundaries serve three turns and keep the returned bytes identical, with no pending repair or repair materialization reason. After the first unmerged **served** turn, its new cached proof can legitimately fold the duplicate on a later turn; that is not an additional unproven repair. The log witness deliberately does not add that proof between attempts.

## The earlier six findings and rebase checks

All corresponding tests passed in the complete Pi gate. This does not negate the narrower counterexamples above.

| Required property | Evidence checked | Result / qualification |
|---|---|---|
| Quoted receipt and transformed-message cached proof | `issue-650-review-r2.test.ts`: quoted `ctx_reduce` receipt, stripped reminder, transformed multipart message; `issue-650-recovery.test.ts` cached variants | Fixed for the r2 shapes; dropped-message proof and argument-sentinel quotes remain findings 3/6 |
| Unproven duplicates with an in-memory but unhelpful array | r2 never-served duplicates and recovery missing-evidence tool/message variants | One declared repair serves rather than refusing |
| `/ctx-flush` fold followed by scheduler defer | r2 flush-at-pass-zero and flush-after-fold partners | No second undeclared defer-byte change |
| Position-independent fallback IDs and switching matching lanes | r2 index-shift and header-to-fingerprint fixtures; `issue-650-r3.test.ts` content fallback/re-key tests; real OMP note movement below | Unique messages and tool owners remain stable; exact duplicate occurrence identity is still position-relative (finding 4) |
| Once guard under a changed unresolved tool owner | r2 owner/index recurrence fixture; recovery recurrences | Tool timestamp/call key survives owner changes; analogous message fallback-to-real guard does not (finding 5) |
| Repair attribution | r2 `classifyCacheBust` tests; `packages/plugin/scripts/cache-bust-attribution.ts:181-184,403`; dashboard `packages/dashboard/src-tauri/src/db.rs:1703` | Class `accounted_tag_identity_repair`, materialize reason `tag_identity_repair`, dashboard label `Tag identity repair` are present. Dashboard Rust tests were not separately run in this test-only review |
| Re-keying marks OpenCode stall-fix caches dirty | `issue-650-r3.test.ts`: `re-keying an older build's message row counts as a tag identity write`; `packages/plugin/src/shared/sqlite.ts:295-333,369-435` | Re-keying `message_id` advances tag-identity generation. The conservative UPDATE classifier does not classify that assignment as identity-free |
| Raw ordinal offset survives the rebase independently of fallback IDs | `pi-ordinal-alignment.test.ts`, `pi-ordinal-offset-review.test.ts`, and raw-session reader tests in the full Pi run | Offset derives from stored compartment boundary IDs versus raw branch ordinals. `piContentFallbackIds` receives messages and a real-ID resolver, **not** this offset. No offset-to-tag-ID coupling was found |

The cumulative served-number union is not itself a reason to refuse anymore: both reporter-shaped 8/154 and 20/440 recovery matrices pass. A cached request can prove a particular number despite a large historical union. Full-capacity decision tests also pass for liveness; their logging defect is separate.

### Separate storage fence, not an identity-repair defect

The served-number JSONL remains mandatory identity storage. `getPiServedTagNumbers` rejects malformed/unreadable records, and `capturePiServedArray` wraps identity-publication failures in `PiServedIdentityError` (`served-array-ledger.ts:82-119,323-333,363-379,407-411`). The handler deliberately refuses failed publication rather than replaying an array whose new identities were never recorded (`context-handler.ts:5678-5686`). The existing isolated corruption and publication-refusal tests passed.

A persistent failure in **that** store can still repeatedly block requests; I did not classify it as a duplicate-conflict recurrence or recommend bypassing the general identity-publication fence. Findings 1/2 concern the separate repair/content-decision ledger, where the prescribed safe unmerged outcome is available. This distinction matters when interpreting “a failed write” in the ruling.

## Reporter-shaped fixtures on the actual host versions

New replay driver: `packages/e2e-tests/scripts/issue-650-r3-host-probe.ts`. It uses the repository's mock HTTP provider and persistent RPC harness with the **prepared checkout's plugin build**. These are synthetic, privacy-safe fixtures, not the reporters' unavailable transcripts.

### Reproduction

Install exact host versions into the isolated root (npm 11.19.1 was used). Set the isolation exports shown above first, and also `CFFIXED_USER_HOME="$HOME"` on macOS:

```sh
ROOT="${TMPDIR:-/tmp}/magic-context/issue-650-r3"
mkdir -p "$ROOT"/{home,data,config,state,runtime,agent,storage}
export HOME="$ROOT/home" CFFIXED_USER_HOME="$ROOT/home" \
  XDG_DATA_HOME="$ROOT/data" XDG_CONFIG_HOME="$ROOT/config" \
  XDG_STATE_HOME="$ROOT/state" XDG_RUNTIME_DIR="$ROOT/runtime" \
  OPENCODE_DB="$ROOT/opencode.db" MAGIC_CONTEXT_STORAGE_DIR="$ROOT/storage" \
  PI_CODING_AGENT_DIR="$ROOT/agent"
npm install --prefix "$ROOT/installs/pi-1.1.0" --no-audit --no-fund \
  @earendil-works/pi-coding-agent@1.1.0
npm install --prefix "$ROOT/installs/omp-18.8.7" --no-audit --no-fund \
  @oh-my-pi/pi-coding-agent@18.8.7 pi-rewind@0.5.0
# From the repository root, with its prepared plugin dist:
ISSUE_650_R3_ROOT="$ROOT/pi-shape" \
ISSUE_650_R3_INSTALL_ROOT="$ROOT/installs" ISSUE_650_R3_HOST=pi \
  bun packages/e2e-tests/scripts/issue-650-r3-host-probe.ts
ISSUE_650_R3_ROOT="$ROOT/omp-shape" \
ISSUE_650_R3_INSTALL_ROOT="$ROOT/installs" ISSUE_650_R3_HOST=omp \
  bun packages/e2e-tests/scripts/issue-650-r3-host-probe.ts
```

No repository package manifest or lockfile was changed by those isolated installs. The package test script also ran its frozen install and reported no dependency changes.

### Pi 1.1.0: prior extension rewrites tool-result text

The injected extension runs before Magic Context and replaces tool-result text with `compacted output: probe650`. A real `bash` call returns `probe650`; three prompts then complete. The driver checks both that the rewritten output actually reached the provider and that the same call has exactly one tag row.

Final result: **3 served turns, 4 provider requests, one tool tag (2), no extension diagnostics**. Separately, the existing SDK/codemode probe served three turns with framing/prose edits and kept identical tool-result bytes and one real owner mapping (4 requests). This covers the message-rewriting shape without claiming to reproduce the exact proprietary optimizer implementation or the unexplained initial duplicate.

### OMP 18.8.7 with pi-rewind 0.5.0 installed

The driver loads the actual `pi-rewind/src/index.ts` alongside Magic Context and the fixture extension. After 17 warmup prompts it adds three context-only user notes which are **not session entries**. It moves those notes from the front to the middle on the next request, then navigates back to the pre-fixture branch anchor and serves another prompt.

Input message counts are **38, 40, 38**, with three unmatched notes each: **7.89%, 7.50%, 7.89%** of message slots. All three notes reach the provider with tag numbers **34, 35, 36** on every shaped request despite movement and rewind. Final result: **3 served shaped turns, 20 total provider requests (17 warmups + 3), no extension diagnostics**.

The branch jump uses `ctx.navigateTree(anchor, {summarize:false})`, the same host navigation API used by pi-rewind. **It does not drive pi-rewind's interactive checkpoint picker or restore worktree files.** Installed plugin compatibility and host branch/context behavior are exercised; a full file-checkpoint `/rewind` workflow and the reporter's actual automatically built unmatched messages remain unverified. The fixture deliberately models their shape rather than asserting their origin.

### Live-store isolation evidence

Every host launch used a fresh RPC/SDK session root under the system temporary `magic-context` tree. HOME, XDG data/config/state/runtime/cache, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR`, and the `.pi/agent` or `.omp/agent` directory were redirected. The new driver captures `lsof -p <host pid>` at startup and after the shaped turns, rejects any `.db`/WAL/SHM path outside that host root, and requires nonempty database evidence on the final audit. Startup had no open DB yet; it is **not** presented as proof of final database isolation.

Final audited processes and roots (all under `/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/`):

| Host | PID | Root / database files observed |
|---|---|---|
| Pi rewrite probe | 21109 | `issue-650-r3/pi-shape/pi-e2e-ZCdHDU/`: only `data/cortexkit/magic-context/context.db` and its WAL/SHM |
| OMP unsaved/rewind probe | 21127 | `issue-650-r3/omp-shape/omp-e2e-SGEQjQ/`: `.omp/agent/{agent,models,skill-descriptions}.db`, `.omp/cache/legacy-pi-extension-cache.db`, `data/cortexkit/magic-context/context.db`, and their WAL/SHM |
| Pi SDK/codemode probe | 57178 | `issue-650/host-beDB2D/`: only `MAGIC_CONTEXT_STORAGE_DIR/context.db` and its WAL/SHM; audits before and after all turns |

Retained evidence outside build/cache directories:

- `$TMPDIR/magic-context/issue-650-r3/pi-shape/{pi-result.json,pi-requests.json,pi-context.jsonl,pi-final-lsof.txt}`
- `$TMPDIR/magic-context/issue-650-r3/omp-shape/{omp-result.json,omp-requests.json,omp-context.jsonl,omp-final-lsof.txt}`
- `$TMPDIR/magic-context/issue-650/host-beDB2D/{result.json,requests.json,lsof.txt,lsof-final.txt}`

Here `$TMPDIR` means the original system temp directory above, not the driver-mutated per-host TMPDIR. No live `.pi`, `.omp`, OpenCode/CortexKit config, or live store was read, opened, migrated, or written. The two early SDK bundle attempts failed at module linking before opening any store (the external `sharp` dependency needed the package-local node_modules link in the throwaway build directory); the final SDK run passed both audits.

## Gates and limitations

- **Pi typecheck:** `bun run typecheck`, Linux; Bun **1.4.2**, TypeScript **5.9.3**; passed (`tsc -p ../retina-local-fs/tsconfig.build.json && tsc --noEmit`).
- **Required Pi package test gate:** `bun run test`, Linux background job, **4 vCPUs / 4 file workers**; Bun **1.4.2**; **1918 pass, 10 skip, 0 fail, 1928 tests / 196 files, 85939 assertions**. Includes all prior identity, ordinal-offset, fallback-write-generation, new expected-failure/partner tests, and cache-bust analyzer tests.
- **First gate attempt:** failed with 146 failures after isolated HOME removed the remote runner's Git ownership configuration. The log explicitly reported `fatal: detected dubious ownership` for this worktree, disabling project-identity-dependent tests. The rerun wrote a `safe.directory` entry for this worktree **only into the throwaway HOME's `.gitconfig`**, and the entire gate passed. No repository/user Git config was changed.
- **Exposed failures:** `ISSUE_650_EXPECT_RED=1 ... bun test src/issue-650-review-r3.test.ts` on Linux: 8 pass / 10 fail; the later `--test-name-pattern 'unsaved note'` run: 1 pass / 1 fail. All 11 failures named in this report are expected and accepted only in the default `test.failing` run. No product mutation was used.
- **Host driver typecheck:** complete E2E `tsc --noEmit -p tsconfig.json` found existing unrelated E2E errors plus one new optional-session-ID error. The latter was fixed by checking the returned ID before binding SQL. A temporary config extending the package tsconfig and including just the new script and its transitive imports then passed TypeScript **5.9.3** locally. Its Linux request was refused as unreachable; this single narrow local fallback is recorded. The temporary config was removed. Complete E2E typecheck remains a baseline gap, not a green claim.
- **Final real-host gates:** both new probes passed after the final assertions/type fix; Pi **1.1.0**, OMP **18.8.7**, pi-rewind **0.5.0**, Bun **1.4.2**. Counts and isolation audits are above.
- **Final narrow review gate:** Linux `bun run typecheck` followed by `BUN_JSC_useOMGJIT=0 bun test src/issue-650-review-r3.test.ts --max-concurrency 4 --timeout 30000`: TypeScript **5.9.3**, Bun **1.4.2**; **20 pass / 0 fail, 47 assertions** (11 are expected-failure witnesses, not fixed product behavior).
- **Formatting/lint:** project-installed Biome **2.5.1**, only the two new TypeScript files; final Linux `biome check` checked **2 files with no findings**. Comment review performed; ambiguous comments were rewritten to identify the decision, number set, and rebuilt message list explicitly.
- **AFT diagnostics:** no TypeScript errors/warnings in its reported scoped file; structural/callgraph categories were partial because this checkout's callgraph view was unavailable. The compiler gates, not that partial inspection, are the authoritative evidence.
- **Not run:** dashboard Rust suite, broad E2E/native suites, actual optimizer packages, concurrent OMP sessions, interactive pi-rewind file restoration. None is required to reproduce the seven findings; they are additional coverage gaps rather than claims of correctness.
