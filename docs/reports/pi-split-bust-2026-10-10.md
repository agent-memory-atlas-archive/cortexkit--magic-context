# Pi split-bust investigation — 2026-10-10

## Conclusion

The 16:35:57 bust was **not a leftover permission from the 16:34:54 hard fold**. A new `/ctx-flush` completed at **16:35:49.883Z**, between the byte-stable defer and the second bust. It flushed two queued drops and explicitly armed the next provider call. The first defer had no reclaim permission; the second did. Suppressing the latter permission would ignore a real command, not repair invariant 1.

No production permission change is made. Regression coverage now verifies that Pi and OpenCode consume a flush on a hard-fold pass, drain queued work, and replay the following unarmed defer byte-identically. Both tests reject a mutation that leaves the flush permission armed.

## Evidence and isolation

Read-only incident sources:

- Session `019de471-4fdc-762d-9286-624dfad0b5fe`: `~/.pi/agent/sessions/--Users-ufukaltinok-Work-Projects-CortexKit-anthropic-auth--/2026-05-01T16-48-44-508Z_019de471-4fdc-762d-9286-624dfad0b5fe.jsonl`.
- Request bodies `001-req.json`, `002-req.json`, `003-req.json` under `/Users/ufukaltinok/Work/Projects/CortexKit/anthropic-auth/.pi/pi-llm-debugging/019de471-4fdc-762d-9286-624dfad0b5fe/`.
- Pi log: `$(getconf DARWIN_USER_TEMP_DIR)pi/magic-context/magic-context.log`. The intended path exists; on this host its root is `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/`.
- An explicitly read-only SQLite connection to `file:/Users/ufukaltinok/.local/share/cortexkit/magic-context/context.db?mode=ro` (`uri=True`) for this session's attribution rows. No `store.db`, OpenCode database, or live configuration was opened.

Host data-analysis runs and verification environments use a throwaway root under `$TMPDIR/magic-context/bg_e8e54e82b3f51e83/`, with private HOME, temporary directory and XDG roots. Incident files were not modified. No `OPENCODE_DB` was exported. Linux verification also uses private roots.

## Timeline: what actually granted the second pass

| UTC | Evidence | Meaning |
| --- | --- | --- |
| 16:20:36.241 | JSONL line 91990, `/ctx-wrapup` status | First wrapup already running before the investigation window. |
| 16:29:10.735 | JSONL line 92005 | Chunk 8 begins, after seven successful chunks. |
| 16:34:54.944 | Log line 104205 | `ttl_idle` hard fold executes. |
| 16:34:56.731 | Log line 104218 | Cleanup rides `hardFold+explicitFlush+publishedHistory`, draining the outstanding publication work. |
| 16:35:01.359 | JSONL line 92007 | Native compaction `e4eeae2a` keeps `2ff58cce`, covers through ordinal 71013. |
| 16:35:34.630 / .835 | Log lines 104383 / 104392 | First defer: two pending ops, `scheduler_defer`; neither pending-op application nor heuristics runs. This directly contradicts an explicit-flush latch continuously surviving the fold. |
| **16:35:49.883** | **JSONL line 92011, custom entry `6472ba34`, title `/ctx-flush`** | **“Flushed 2 pending ops; next provider call will materialize.” Details: `pendingBefore: 2`, `result: "Flushed: 2 dropped. Changes take effect on next message."** |
| 16:35:52.612 | JSONL line 92013 | First wrapup ends partial: seven compartments, no progress on chunk 8. |
| 16:35:56.920 / 16:35:57.151 | Log lines 104456 / 104466 | Second defer: `explicit_flush`, `pendingOps=0`, cleanup rides `explicitFlush+publishedHistory`. Zero pending ops is expected: the command already flushed the two drops. |
| 16:35:59.373 | JSONL line 92015 | A second `/ctx-wrapup` starts **after** the second bust. It cannot have authorized that bust. |

Pi slash commands appear here as custom status entries, not necessarily user-message text containing the command. Searching only message text would miss the decisive `/ctx-flush`.

### Permission lifecycle

Pi's flush command signals history refresh, system-prompt refresh, and pending materialization (`packages/pi-plugin/src/commands/ctx-flush.ts:43-64`). `hasPendingMaterialization` is a peek, and successful cleanup drains it (`packages/pi-plugin/src/context-handler.ts:1219-1231,7486-7495,7827-7836`). Protection or failed cleanup may intentionally retain work for retry; that is not the observed sequence.

`/ctx-wrapup` signals **deferred** history refresh/materialization in its `onPublished` callback for each successful chunk, not unconditionally at completion (`packages/pi-plugin/src/commands/ctx-wrapup.ts:393-423,457-550`; `packages/pi-plugin/src/pi-historian-runner.ts:1523-1529`). Chunk 8's historian result failed validation at 16:35:52.541 (log line 104430); there was no successful chunk-8 publication. The new explicit flush, not end-of-wrapup rearming, explains the later permission.

OpenCode's flush callback similarly arms refresh and pending materialization (`packages/plugin/src/hooks/magic-context/hook.ts:1024-1030`). Its successful shared postprocess removes the pending signal, unless the fold is frozen or thinking protection prevents application (`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:2848-2857`). Pi and OpenCode share the reclaim-ride predicate but have their own consumption paths.

## 1. Exact tail change

`002-req.json` (mtime 16:35:35.057936Z, 1,220,301 bytes) versus `003-req.json` (mtime 16:35:57.988424Z, 1,161,592 bytes):

- Instructions are identical.
- The first **760 raw OpenAI `input` items** are identical.
- First differing raw-file byte: **619,577**, zero-based, at the item following `[dropped §58245§]`.
- Analyzer `message[761]` corresponds to raw `input[760]`: normalization prepends the OpenAI instructions as a system message (`packages/plugin/scripts/cache-bust-body-sources.ts:172-188`). There is no off-by-one join defect here.

Before, the next items are:

```json
{"type":"function_call","call_id":"call_1b632ae7e1a243508f8e9c7c50d55152","name":"read","arguments":"{\"path\":\"packages/opencode/src/tests/index.test.ts\",\"startLine\":2407,\"endLine\":2448}"}
{"type":"function_call_output","call_id":"call_1b632ae7e1a243508f8e9c7c50d55152","output":"§58246§ 2407: ..."}
{"role":"user","content":[{"type":"input_text","text":"§58247§ <system-reminder>\nWake digest\n\n## Peer messages\nMOTOR (...)"}]}
```

After, that tool invocation/result pair is gone and the reminder has become:

```json
{"role":"user","content":[{"type":"input_text","text":"[dropped §58247§]"}]}
```

The snippets omit the provider's function-call `id` and clip the tool output/reminder, but the raw-byte comparison includes them. The pair deletion plus reminder replacement is the first changed block: before raw items `[760,763)`, after `[760,761)`, compact UTF-8 JSON sizes 2,571 versus 78 bytes.

There are only two other unequal blocks after aligning identical items:

- Delete seven encrypted reasoning items, before raw `[948,955)`, 57,254 compact JSON bytes.
- Append the new sidekick call/result, after raw `[1035,1037)`, 1,395 compact JSON bytes. This is ordinary newly appended work, not a cache-prefix rewrite.

Raw input-item counts are **1,044 → 1,037**. About 185k cache tokens being rewritten does not mean 185k tokens of different text: a change this early invalidates the following cached prefix.

### Head identity

The two head texts are byte-identical across these bodies:

| Head | UTF-8 bytes | SHA-256 |
| --- | ---: | --- |
| m[0] text | 349,820 | `ad933538dc5ad4d4bba4a7bdd22c6428bf74997ddd7f764f75704f870eb3596f` |
| m[1] text | 90 | `2b0276c2621dab10849474a7df849950a6b1e0c1cabc9a6de1c123ff12077c41` |

The log's m[0] size **349,241** is the text's character count, not its UTF-8 byte count. This measurement distinction does not change the identity conclusion.

## 3. Native marker timing and message counts

The premise conflates **transform output** counts with **input** counts. The completion log prints `outputMessages.length` (`packages/pi-plugin/src/context-handler.ts:4963`). Actual entry-array counts are:

| Pass | `findSessionId` input | Transform output | Raw provider input items |
| --- | ---: | ---: | ---: |
| Fold | 13,847 (log 104184) | 2,623 | 1,040 |
| First defer | **6,911** (log 104365) | **2,625** | **1,044** |
| Second defer | **6,913** (log 104439) | **1,006** | **1,037** |

The native cut had **already taken effect on the first defer**, where the analyzer reported STABLE. It did not first take effect at 16:35:57. The marker's covered-history cut was therefore compatible with unchanged served history in this incident.

The second pass's output shrink is explained by cleanup authorized by the new flush:

- Log 104468: four system injections dropped.
- Log 104470: seven reasoning blocks cleared, watermark 58349 → 58350.
- Log 104474: tool reclaim auto-drop, 73 targets.
- Log 104479: placeholder strip, 1,620 removed/discovered and 1,206 frozen IDs pruned.

“Pruned” means IDs removed from the persistent replay set, not an additional 1,206 wire messages. Pi discovers marker-only assistant rows on an authorized bust, persists that decision, and strips them; it does not discover fresh strips on ordinary defer (`packages/pi-plugin/src/strip-placeholders-pi.ts:31-67,137-202`). Thus many host output messages disappear while relatively few provider input items change. The marker changed the raw-array shape on the earlier stable pass; the later explicit flush admitted new tail reductions.

## 4. `no_mc_pass_row`

The permitted `context.db` attribution query found **no decision rows in 16:33:00–16:36:30Z**. It held 2,000 rows for this session, with maximum `ts_ms=1791634144976` (**12:09:04.976Z**), well before the incident; there was no `scheduler_history` table. This is a telemetry-availability gap, not evidence that the scheduler did nothing: the incident log records the decisions and permissions.

The analyzer joins within `[request − 30s, request + 5s]`, further bounded by the previous request, then prefers a matching message ID or nearest preceding pass (`packages/pi-plugin/scripts/analyze-pi-cache-busts.ts:442-480`). None of the available context rows can match the 16:35:57 request. `no_mc_pass_row` means no loaded matching attribution, not “MC did not edit bytes.” Its existing synthetic tests cover in-window, detached-ID, and out-of-window cases (`packages/pi-plugin/scripts/analyze-pi-cache-busts.test.ts:564-655`).

The shared loader can also read Rust scheduler histories from `store.db` (`packages/plugin/scripts/cache-bust-sentinel.ts:642-657`). That live store is explicitly outside this investigation's read permission. Therefore the report does **not** claim the pass is absent from every diagnostic store, or establish why the context mirror lacks recent rows. No timestamp/ID join error is demonstrated by the permitted evidence.

Pi attribution is staged in per-session memory at the end of a successful busting context pass, and resolved on a **later context pass** against a newer assistant branch entry (`packages/pi-plugin/src/context-handler.ts:3265-3272,4377-4415,5075-5078`). It is not written by `message_end`; that callback persists pressure metadata. The resolver discards the pending item if its publication/current-pass guard throws, producing the exact log seen at **16:35:34.313Z** (`packages/plugin/src/features/magic-context/transform-decision-log.ts:319-368`). This explains why the fold's pending attribution need not reach the database. The last bust's attribution likewise is not guaranteed to be available at its own request boundary. The evidence does not identify which guard threw, or explain all missing rows, so the attribution gap remains a diagnostic follow-up rather than a fabricated flush-consumption fix.

Analyzer and runtime use the same default storage resolver: `MAGIC_CONTEXT_STORAGE_DIR`, then `XDG_DATA_HOME/cortexkit/magic-context`, then the home-directory default (`packages/plugin/src/shared/data-path.ts:229-249`; analyzer `:174-209`; Pi runtime `packages/pi-plugin/src/index.ts:1176-1182`). Different environment/CLI overrides could still point them at different stores; live configuration was not read. The analyzer CLI was not rerun against the live served-array ledger or `store.db`, which were outside the allowed sources; its supplied verdict was checked against the actual request bodies and permitted context rows instead.

## Later evidence: the 17:02:03 pass

The repeated `explicitFlush` label is not proof of a permanently armed manual flush. Pi computes it as **manual pending materialization OR eligible deferred publication** (`packages/pi-plugin/src/context-handler.ts:7038-7056`). The second operand is deliberately labelled `explicitFlush` too, even though no `/ctx-flush` command caused it.

Both `pendingMaterializationSessions` and `deferredMaterializationSessions` are **module-scoped in-memory `Set<string>` values**, not fields in `session_meta` (`packages/pi-plugin/src/context-handler.ts:650-655`). `consumePendingMaterialization` deletes the manual latch after successful pending-op application when heuristics are disabled, or after successful heuristic cleanup when enabled; thinking-protected work retains it for retry (`:1219-1231,7486-7495,7827-7836`). Deferred materialization drains after the full successful pass (`:7854-7871`), and may be rearmed specifically to preserve a still-pending compaction-marker retry (`:8540-8545`). Session teardown and compaction-off cleanup clear both sets (`:9276-9282,9320-9333`). Other manual-latch setters include cache-busting thinking-level changes, stable-ID cutover, and the end of thinking recovery (`:3135-3150,4050-4064,6568`). Successful historian and wrapup publications arm the deferred set, not an immortal manual flag.

Importantly, **the deferred operand is eligible only on execute, force materialization, or force-band usage** (`:6825-6834`), so simply retaining deferred publication through low-pressure defers does not authorize those defers. Apply-reason logging prefers `explicit_flush` when the manual latch is set; `deferred_publication` selects the other branch (`:7438-7448`).

At **17:01:28.668/.874**, the same session logged pending ops **WILL NOT APPLY** (`scheduler_defer`, two queued ops) and heuristics **WILL NOT RUN** (log 111515/111524). At **17:02:03.166**, pending-op application explicitly names **`deferred_publication`**, not `explicit_flush` (log 111678). The m[1] soft refresh to 5,824 characters happens at 17:02:03.040; its fold decision is `soft_refresh`, `executed=false` (log 111674/111675). The later `explicitFlush+publishedHistory` ride is therefore consistent with publication being consumed on the execute pass, not a manual latch authorizing every preceding defer. The session JSONL has no additional `/ctx-flush` status between 16:35:59 and 17:02:08; the second wrapup ends with zero publications at 16:42:18.427 (line 92048).

### The 3.588-second interval is not 3.588 seconds of heuristic cleanup

From `heuristics WILL RUN` at **17:02:03.370** to `batchFinalize:heuristics` at **17:02:06.958** (log 111688–111705):

| Work | Logged cost / effect |
| --- | --- |
| `applyHeuristicCleanup` | **40.2 ms**; 24 system injections dropped, no dropped tool tags or deduplicated calls |
| `clearOldReasoning` / `watermarkCleanup` | **30.9 ms** (one operation, not two additive costs); 55 blocks cleared |
| Adjacent foreground `apply_pending_operations` SQLite transaction | **2,153.7 ms hold**, zero acquisition wait, one committed attempt, logged at 17:02:05.619 |
| `transcriptCommit` | 5.6 ms |
| Tool-reclaim auto-drop | 82 targets, `mutated=true`; completion logged at 17:02:05.692 |
| `postCommitStableIdMaps` | 2.6 ms |
| `prepareCompartmentInjection` / `compartmentPhase` | **1,224.6 ms** (same interval, not two additive costs) |
| Placeholder strip | 6.9 ms; 1,509 frozen removals, no discoveries/pruning |
| Native marker drain | Persists `fdd910e0`, through ordinal 71283, at 17:02:06.944 |
| `batchFinalize:heuristics` | 0.0 ms for finalization itself, not an inclusive phase timer |

The writer line is not session-tagged, so attribution to this session is based on its location in the pipeline interval, not an independent session ID on that transaction. Source also places synthetic tool-reclaim application between watermark cleanup and transcript commit, followed by image/reminder replay (`packages/pi-plugin/src/context-handler.ts:7987-8140`); the initial queued-op application earlier in this pass was only 1.7 ms. The two dominant observed costs are nevertheless the adjacent **2.154-second transaction hold** and **1.225-second compartment preparation**, not the 40 ms cleanup. There is no lock-acquisition delay on that transaction. This is a separate cost lead; no performance changes are included in this permission investigation.

## Verification scope

The added tests use actual Pi context handling and OpenCode postprocess with in-memory stores and distinct raw versus served arrays. They bootstrap a served prefix, queue a drop, arm one flush, force a model-key hard fold, assert consumption/application, then compare serialized served bytes on an unarmed defer and assert heuristics do not run. A model-key fold exercises the same consumption contract without wall-clock-dependent idle-expiry timing.

Mutation controls (both restored before package gates):

1. Remove Pi's `pendingMaterializationSessions.delete(sessionId)` in `consumePendingMaterialization`. Only **Pi fold content replay > consumes a flush on a hard fold and replays the next defer byte-identically** failed (`Expected false; Received true`); the OpenCode regression passed.
2. Remove OpenCode's corresponding successful-pass deletion. Only **executed m[0] hard-fold folds the execute pass in > consumes an OpenCode flush on a hard fold and replays the next defer byte-identically** failed (`Expected false; Received true`); the Pi regression passed.

Each control was marked `NON-VACUITY BREAK`, applied only after staging the live baseline with an empty working diff, showed `1 file changed, 2 insertions(+), 1 deletion(-)` while applied, and was restored from the index followed by `touch`; the working diff was empty after each restore. These are regression controls, not production changes.

### Gates

All executable verification ran on Linux (`ck-motor`); no fallback to host tests was needed. Versions: **Bun 1.4.2 (744846f84)**, **TypeScript 5.9.3**, **Biome 2.5.1**.

| Gate | Result |
| --- | --- |
| `bun run --cwd packages/pi-plugin test` | 1,811 passed, 10 skipped, 1 failed / 1,822 tests. The unchanged `removal markers survive a separate-process restart (native=false)` test's child hit its 5-second timeout under the full parallel suite. It passed in the file-isolated focused rerun below. |
| `bun run --cwd packages/plugin test` | 7,556 passed, 19 skipped, 11 failed / 7,586 tests. Failures are outside the changed files: nine auto-search worker bundle probes cannot find remote `dist/auto-search-worker.js`; the Node WASM fixture cannot resolve `onnxruntime-web/webgpu` from its generated temporary bundle; the Windows spawn guard names an existing `spawnSync` in `src/shared/sqlite.test.ts:34`. No unrelated production/test fixes were made. |
| Pi and plugin `bun run typecheck` | Passed, exit 0; repository scripts run two / three TypeScript configurations respectively. Their normal typecheck scopes exclude test files. |
| Pi `bun run lint` | Passed; 282 files checked, 10 existing warnings. |
| Plugin `bun run lint` | Passed; 1,342 files checked, 10 warnings and 6 informational diagnostics. |
| Focused `bun test --parallel=4 --max-concurrency 4 --timeout 30000` on both changed test files, Pi analyzer, `/ctx-wrapup`, and `overwall-upgrade-replay` | **308 passed, 1 skipped, 0 failed**, 309 tests across five files, 1,757 assertions. Both new regression tests passed. File isolation matches the package test scripts. |
| Comment review | Added test comment reviewed, none flagged. |
| AFT diagnostics | Partial: no authoritative analyzed files in the scoped checkout view. Repository TypeScript gates and executable tests are the authority. |

The first broad gate attempt was interrupted by an AFT restart during plugin tests; Pi had also encountered Git dubious-ownership failures because its throwaway HOME omitted the runner's safe-directory setting. The completed rerun allowed **only this worktree path** in a private throwaway `.gitconfig`, never changing live Git configuration. The Pi import-order lint finding introduced by the test was fixed before the completed rerun. A first multi-file focused run without file isolation encountered existing cross-file marker-mock interference; rerunning with the package's `--parallel=4` isolation produced the green focused result above. Frozen-lockfile installs checked 1,010 installs across 1,251 packages without manifest/lockfile changes.
