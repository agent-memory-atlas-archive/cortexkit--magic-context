# issue 650: Pi tool identity regression and byte-safe recovery

Historical record for commit `9ce293ec`. The independent review found that the
reporter's realistic last-served state is **154 active**, not cached 8 dropped.
The later resolution preserves 154, requeues the losing drop, and supports a
one-shot declared rebuild when bytes are missing. See
`issue-650-review-resolution.md`; the original conditional fixtures below do not
establish recovery of the realistic reporter state.

## Reproduction and cause

The deterministic reproduction uses a **real Pi SDK session**, a localhost
scripted Anthropic mock, and the production context handler. It runs on the
harness's **Pi 0.83.0** and on **Pi 1.1.0**. The latter also runs the real built-in
codemode extension, successfully calling `tools.bash` inside its QuickJS script.
No reporter transcript or database was available; this proves a mechanism, not
which upstream extension or session operation triggered the reporter's incident.

Sequence of events in the reproduction:

1. Prompt once; the mock returns one tool call. Pi persists its assistant entry
   before the tool-loop context pass. MC serves the result with one real-owner
   tool tag (number 2 in these probes).
2. A preceding context extension inserts temporary user framing and adds prose to
   that assistant, leaving its timestamp and tool-call id/arguments unchanged.
   Two framing messages make this deterministic on both versions (1.1.0's
   branch also contains a system entry which its `context` hook hides).
3. The context message count differs from the branch's emitted entry-id count,
   disabling positional alignment and selecting fingerprint-based matching. The prose edit
   invalidates the whole-message fingerprint, so the assistant gets a `pi-msg-*`
   owner. Original code mints a new tag for this **same** call (5/6), and serves it.
4. Stop the context-only edits and prompt again. Original fallback-to-real
   adoption sees both numbers in the cumulative served-number ledger and refuses;
   only three provider requests arrive instead of the expected four. Retrying
   with the same identities cannot resolve that collision.

The second-tag allocation path in the pre-change repository commit
`691725deaa173eb4ddd2d9474efe554f96056d3e` is:

- `packages/pi-plugin/src/context-handler.ts:2732-2742`: count mismatch chooses
  `collectMessageEntryIdsByRef`.
- `context-handler.ts:1732-1752,2074-2096`: whole-message content fingerprint misses.
- `packages/pi-plugin/src/read-session-pi.ts:124-143`: unresolved entry becomes
  `pi-msg-${index}-${timestamp}-assistant`.
- `context-handler.ts:2387-2405`: adoption only scans **existing fallback rows**
  towards a real owner, so it cannot reconcile the real-to-fallback transition.
- `packages/plugin/src/shared/tag-transcript.ts:516-529` calls
  `packages/plugin/src/features/magic-context/tagger.ts:575-658`.
  Its exact owner/call lookup at **595-603** misses, and **643-658 mints the second
  number**. The reproduction allocates and serves both rows without a SQLite
  lock, explaining why storage-busy retry advice cannot resolve this conflict.

Normal persistence is not late in this probe. Restore, branch navigation and
compaction can change the projection, but they are not needed for the
reproduction and their involvement in the original report is unknown.

## Identity and refusal changes

Pi now has a separate, unique assistant-tool identity index keyed by the embedded
assistant timestamp and ordered tool-call id vector. It is used only if the exact
content fingerprint is missing. Prose edits therefore cannot change the tool
owner. Ambiguous entries remain unresolved; call id alone is never an identity.
Adoption and transcript construction use the same stable-id resolver, including
reference-resolved owners with missing positional slots.

Fallback-to-fallback adoption also handles visible-index drift while a real entry
id is unavailable. A pre-allocation guard refuses when existing real/fallback
owners cannot be distinguished safely. Distinct real owners can still legitimately
reuse a call id: the guard preserves separate `(assistant owner, call id)` keys,
not a single key shared by all invocations of a call id.

A conflict means one call has incompatible stored tag identities. The typed
`PiTagIdentityConflictError` bypasses storage-busy recovery, replay of the last
known-good (LKG) managed array, and fallthrough to unmodified host input. It
reaches the host abort guard with its own message:

> Magic Context tool-tag identity conflict: … This turn was refused without
> sending raw history; resending alone will not repair it

No unreduced/raw request is served after an identity conflict, even when it fits.
The identity error is recognized even inside another error's `cause` chain;
the tagger's in-memory assignment cache is cleared on refusal. Real-host-hook tests verify abort and the absence of the
storage-busy / send-your-message-again wording.

## Recovery and surviving number

For tag 8 on the real assistant owner (dropped) and tag 154 on a `pi-msg-*` owner
(active), **8 survives, with its dropped status**, when 8 is the
sole evidenced served number or exact current cached bytes prove it is the sole
visible number. Being active or allocated later does not make 154 authoritative.
The model's existing `[dropped §8§]` bytes must not become an active `§154§` result.
The inverse is supported when the fallback number was the one served, provided
folding the duplicate cannot turn its served active bytes into dropped bytes.

The `pi-served-tag-numbers` identity ledger accumulates numbers across returned
arrays and process lifetimes; it is not a description of the current cached array. When it names both numbers, recovery requires all of:

- The LKG's **exact serialized array SHA-256 matches the last returned-array
  digest**, from process memory or the durable digest ledger. A merely captured,
  never-served LKG is insufficient.
- The cached array contains exactly one owning assistant for this call, with the
  same embedded timestamp, and exactly one matching call in that assistant.
- Only one candidate number appears anywhere in the cached bytes, and that number
  occurs as a generated leading result prefix or exact dropped sentinel for this
  structured tool result. Quoted markers elsewhere can veto repair, never prove it.
- The persisted survivor's active/dropped status agrees with those rendered bytes.
  The losing row must not propagate a drop onto a served active survivor.

The existing transactional fold merges the duplicate into the retained row,
keeping maximum stored byte/token counts, queued operations and retained source
content; it removes the duplicate and
rebinds the tagger. It never renumbers a cached message or rewrites the LKG.
Missing evidence, both numbers in current cached bytes, wrong call/timestamp,
status mismatch, or an unserved LKG refuse without changing either row. No manual
SQL or automatic unconditional deletion is added. Older sessions without enough
served/LKG evidence may remain refused, now with an accurate diagnosis.

Three older collision fixtures assumed unobserved allocations could authorize a
canonical fold. They now explicitly record their claimed served real number;
the accounting fixture also makes its retained real row dropped before serving
its dropped bytes. Assertions about identity, max accounting, aliases and queued
ops are retained. A new refusal case guards against silently propagating a
losing dropped row onto served active bytes.

## Codemode

In Pi 1.1.0, `dist/extensions/codemode/tool.js` runs nested calls through the host
tool pipeline; only the script output becomes the outer `codemode` tool result.
The success path can append `codemode-store` custom entries. In the successful
probe, nested bash execution appears in the outer result's details, not as a
second persisted assistant/tool-result pair. The probe produces one outer
assistant tool-call entry and one outer tool result with the same `call650` id.
MC does not special-case the tool name: bash and codemode use the same identity,
adoption and allocation paths. Codemode is **not required** for the reproduction.

## Separate OpenCode hazard (not changed)

Per parent decision, this task fixes Pi only. OpenCode has no Pi `pi-msg-*`
assistant-owner adoption path, but has a different analogous risk:

- `packages/plugin/src/hooks/magic-context/tag-messages.ts:195-231` handles
  result-only windows after compaction/partial-history reads. Without an in-window
  invocation, it requests persisted owner candidates and host message times.
- `read-session-db.ts:615-643` returns empty/partial times if the harness does not
  own OpenCode storage, the selected database is absent/unopenable, the query
  fails, or candidate/result rows are absent. Pi/OMP intentionally cannot read
  OpenCode. For actual OpenCode, a missing explicit `OPENCODE_DB`, an unavailable
  host DB, or data/schema mismatch is a possible trigger; no user incident was
  established here.
- With no provable nearest-prior owner it uses the **result's own real message id**.
  `tag-messages.ts:955-1027` then calls `assignToolTag` and prefixes that result's
  output with the new number. The shared allocator only sees a new composite key;
  its uniqueness/race checks do not detect this ownership disagreement. There is
  no Pi-style served-number conflict/adoption check in that OpenCode path.

An executable **expected-failure** test named
`OpenCode result-only unavailable message times must not expose a second tag (separate known hazard)`
seeds an assistant-owned call, points `OPENCODE_DB` at a nonexistent throwaway
file, closes/resets the read handle/path memo, and tags a result-only message.
Current output is a fresh result-owned `§2§ result`, not the seeded `§1§ result`.
Changing this to refusal would introduce a new blocked-turn policy; it is left
for separate evidence and review, rather than silently expanding the Pi fix.

## Host scripts and isolation evidence

The reusable scripts are `packages/e2e-tests/scripts/issue-650-host.ts` and
`issue-650-probe.ts`. Bundle the host locally with splitting (a non-splitting
Bun 1.4.2 bundle emitted an undefined `__promiseAll` helper); run the probe with
`ISSUE_650_HOST` set to the desired installed Pi `dist/index.js`, and set
`ISSUE_650_CODEMODE=1` for Pi 1.1.0 codemode. This is not a package-version change.

Each child has a fresh HOME/cwd, isolated `.pi`, every XDG directory,
`OPENCODE_DB`, and `MAGIC_CONTEXT_STORAGE_DIR` under
`$TMPDIR/magic-context/issue-650/host-*`. The parent checks `lsof -p <pid>` before
sending the first prompt and after successful turns, rejects any non-throwaway
DB path, and records the audit. No live stores or configs were opened or migrated.

Evidence root on the Mac:
`/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-650/`.
Per-host directories retain `lsof.txt`, `result.json`, `requests.json`, stdout and
stderr; successful final probes additionally retain `lsof-final.txt`. These are
outside regenerable repository build directories.

Original-code red probes: `host-P7uO2L` (0.83.0, 2 → 5), `host-osh2A2` (1.1.0,
successful codemode, 2 → 6). The original bundle's driver alone was updated to use
two framing messages and close its stdin; the bundled production code remained
pre-fix. An initial 1.1.0 trial had an invalid codemode script, and a startup/exit
trial timed out because the child's stdin remained open; neither is counted as a
successful host verification. Fixed-code early green probes: `host-BBXLRk` and
`host-3KBd2f` (four requests, one number). Final gates and mutation evidence are
recorded in the delivery declaration.

## Final verification

- Mac real hosts, Bun 1.4.2 / Node v26.10.0: Pi 0.83.0 bash (`host-Ksg5wD`),
  Pi 1.1.0 codemode (`host-hg3egA`), Pi 1.1.0 bash (`host-9oIPK8`). Each completed
  three turns / four provider requests, retained one number, and asserted exact
  equality of every served tool-result object. Both opening and final `lsof`
  audits list only each root's `MAGIC_CONTEXT_STORAGE_DIR/context.db` and WAL/SHM.
- Linux Bun 1.4.2: 29 focused Pi identity/collision/cost tests, 21 existing
  adoption/entry-resolution/defer tests, and 15 shared-storage/OpenCode tests
  passed. The 15 include one intentional expected-failure OpenCode invariant.
- Linux `bun run build` passed (plugin, Pi, CLI; generated TUI: 9 unchanged files).
  TypeScript 5.9.3: both package typecheck scripts passed. A temporary config
  extending the Pi config typechecked both new host scripts successfully; its
  contents are retained as `evidence/probe-typecheck-config.json`.
- Biome 2.5.1 checked 10 changed source/test/probe files, with no errors. Seventeen
  warnings remain in test/probe assertions and the cross-version dynamic SDK
  driver; none are in the new production identity helper.
- Full Linux suites were run in background jobs and joined, with `OPENCODE_DB`
  unset and fresh HOME, including frozen-lockfile installs (1,010 installs /
  1,251 packages; no dependency changes). After a remote build: plugin 7,512
  pass / 19 skip / 33 fail; Pi 1,637 pass / 9 skip / 144 fail. These are **not green
  full-suite gates**. An original-runtime control reproduced every one of the
  177 named failures: `evidence/baseline-comparison.json` has `only_built: []`.
  The baseline also had nine extra bundle failures and a filtered new-test import
  error because the original runtime does not export the new helper. No unrelated
  historian/status/memory/ONNX failures were changed to make the gates green.
- Extending typecheck to the complete e2e package exposes existing unrelated
  database/type/API errors. Including the new Pi test file in a temporary check
  leaves only the pre-existing `pi-context-host.test.ts:76` optional-array assertion
  type error; the package normally excludes test files. No new-file type errors
  remain. Scoped checks and the real-host probes provide the change's verification.

Five staged-index mutation controls each failed exactly its named test while an
unrelated positive control stayed green: disable assistant tool identity matching;
disable cached recovery; bypass the returned-array digest comparison; bypass the
shared both-served-number refusal; bypass the pre-allocation ambiguity guard.
Every mutation carried an explicit non-vacuity marker, had a non-empty recorded git diff while
applied, and an empty diff after index restore plus `touch`. Captured failure names,
green control names and stat pairs are retained under `evidence/mutation-*.txt`
and `.stat`, and enumerated in the delivery's `mutation_evidence`.
