# Issue 652: Pi-lineage compaction, pressure accounting, and marker investigation

Investigation date: 2026-10-10. Report only; no product-code changes or new tests.

## Revisions and host identity

- Magic Context (MC) master examined: `977a3d8f5814f8c797fb71ad18ea4b206ec71923` (package version 0.47.0). MC release comparison: `v0.44.4`, resolving to `a2d189f0d8f33caed7fede90bdf15ab95c669372`.
- The original report is [issue 652](https://github.com/cortexkit/magic-context/issues/652); its token counts, 460/631 alignment result, and ordinal 372 are **reporter observations**, not a session replay. No reporter session file or complete configuration was available.
- **Oh My OpenAgent/OMO is not Oh My Pi/OMP.** The reported omo 5.1.28 uses the senpi fork. Public [OMO v5.1.28 release notes](https://github.com/code-yeongyu/oh-my-openagent/releases/tag/v5.1.28) name senpi `2026.10.10-10`, whereas the issue names `2026.10.10-6`. Both versions must not be conflated. The vendored magic-omo extension was not audited; MC 0.44.4 was compared using MC's own tag.
- Supported-host checks used published `@earendil-works/pi-coding-agent@1.1.0` and `@oh-my-pi/pi-coding-agent@18.8.8`. There is no published OMP 5.1.28 at that package name. A separate check used the reporter's published `@code-yeongyu/senpi@2026.10.10-6`.

Unless prefixed with `v0.44.4:`, MC `file:line` references below refer to the master revision above. Host links are pinned in the source index at the end.

## Per-claim disposition

| Claim | Holds on master? | 0.44.4 / fixed since | Host-specific qualification |
| --- | --- | --- | --- |
| 1. MC and host pressure meters can diverge; cancelling required compaction can wedge sends | **Distinct meters and unconditional MC veto remain.** A below-floor MC trigger does not synchronously rescue a native compaction demand. The permanent-refusal conclusion is conditional on a host that makes successful compaction mandatory. It is **not** upstream Pi/OMP cancellation behavior. | The tag also vetoes native compaction and schedules independently from context pressure. Header-ID alignment, lost-prefix ordinal offsets, and the wrapup branch-reader fix leave that veto unchanged. | The exact refusal is in **senpi**, and repeated cancellation/refusal was reproduced there. Pi 1.1.0 and OMP 18.8.8 proceeded after cancellation. The complete reporter low-render/high-ledger state was not reproduced. |
| 2. All MC compaction runs from the host scheduler; host `compaction.enabled: false` stops MC | **No.** Automatic MC historian scheduling runs from MC's `context` handler. `fromHook: true` is marker provenance, not evidence that the host scheduled the historian. | Already false in 0.44.4; not a newly fixed coupling. The tag's context handler calls `maybeFireHistorian`. | With host auto-compaction disabled, actual MC on Pi 1.1.0 and OMP 18.8.8 still fired and spawned a historian. This is not proof about the vendored OMO extension's behavior. |
| 3. Branched histories cannot anchor markers; wrapup falls into small chunks | **Specific defects are fixed; genuinely missing/ambiguous anchors still wait.** A blanket claim that every branch now resolves would be wrong. | Header-anchored event-ID alignment, lost-prefix ordinal offsets, and the wrapup branch-array read were added after 0.44.4; commits below. | These are MC defects affecting Pi-compatible branch APIs, not just senpi. Reporter-specific 460/631 and 10-message behavior cannot be attributed precisely without that branch and historian output. |

## 1. Pressure divergence and native-compaction cancellation

### What MC actually measures

MC's pressure is **request/provider-oriented**, not a universal fresh token count of the compressed render. Master prefers persisted `session_meta.lastContextPercentage` / `lastInputTokens`, populated from accepted provider usage at `message_end`, then falls back to host context usage and, for unusable readings, request-message token estimation. Relevant code:

- `packages/pi-plugin/src/index.ts:842-899`: persisted provider-pressure updates.
- `packages/pi-plugin/src/context-handler.ts:3762-3780,3905-3941`: persisted pressure, live fallback, and request-counting fallback.
- `packages/pi-plugin/src/context-handler.ts:4437-4464,5933-5948`: the context-transform pass's pressure snapshot reaches the historian trigger.
- `v0.44.4:packages/pi-plugin/src/context-handler.ts:2833-2848,3411-3433,4565-4617`: the tag already used persisted pressure/live fallback and a context-driven historian evaluation.

Provider usage describes the request actually served, which can be much smaller than the host's retained history. It is therefore plausible for rendered/request pressure to remain low while a fork's stored-history policy demands compaction. `tokensBefore` in a compaction preparation is not, by itself, proof of the exact meter used by every host's admission predicate.

The veto does not compare request pressure with host stored-history pressure. Master `handlePiSessionBeforeCompact` returns `{ cancel: true }` whenever **MC compaction** is on, and otherwise permits native compaction (`packages/pi-plugin/src/index.ts:361-381`). The tag does the same (`v0.44.4:packages/pi-plugin/src/index.ts:336-356`). That callback does **not** run or await a historian, or verify that an MC marker landed. MC compaction-off is a separate setting from the host's auto-compaction toggle.

### A configuration detail that changes the interpretation

The issue lists both a 20% execute threshold and a 120,000-token threshold. The resolver gives a **usable token threshold precedence** over percentage mode (`packages/plugin/src/hooks/magic-context/event-resolvers.ts:347-428`). With an effective input limit of 300,000, 120,000 tokens means **40% execute / 38% proactive floor**, not 20% / 18%. The floor is execute minus two percentage points (`packages/plugin/src/hooks/magic-context/compartment-trigger.ts:211-215,795-805`).

Thus 22% really is below a 38% floor, but **not below an 18% floor**. The token threshold must be an object with a `default` or matching `provider/model` key; current `execute_threshold_tokens` uses a mapping such as `{ "default": 120000 }`, not a scalar (`packages/plugin/src/config/schema/magic-context.ts:1240-1247`). The effective merged configuration and threshold-resolution log from the affected session are needed before assigning the reported defer to a specific cause. A scheduler `decision=defer` also is not identical to the historian's `shouldFire=false`; they are separate decisions.

### What each host does after `{ cancel: true }`

| Host | Source behavior | Isolated real-host observation |
| --- | --- | --- |
| Pi 1.1.0 | Auto-compaction records cancellation, emits aborted completion, and returns false. Pre-prompt `prompt()` awaits `_checkCompaction()` but does not require a successful result before proceeding. Manual `/compact` cancellation can throw; that is not a blanket next-send refusal. [Pi source: lines 2052-2060,3124-3138,3212-3237][pi-session] | Two prompts accepted; two model requests; one threshold compaction cancelled, `aborted:true`, `willRetry:false`. |
| Oh My Pi 18.8.8 | `session_before_compact` cancellation returns `COMPACTION_CHECK_NONE`; pre-prompt maintenance awaits the attempt without converting cancellation into a required-compaction error. [OMP maintenance: lines 2543-2602,4639-4659][omp-maintenance] | Two prompts accepted; two model requests; four cancellations including repeated pre/post-turn threshold checks. |
| senpi 2026.10.10-6 | Cancellation rejects the compaction with default cause `cancelled-by-extension`. `_runPrePromptCompaction` returns `execution.accepted`; when admitting a provider request whose context remains over the host limit, the host can throw `RequiredCompactionError`. [senpi source: lines 830-835,7336-7375,7810-7853,8208-8264][senpi-session] | Two prompts refused with the exact issue string, twice returning `accepted:false`, `rejectionCause:"cancelled-by-extension"`, `willRetry:false`. Native candidate-summary requests still occurred; refusal does not mean zero total HTTP traffic. |

The exact string `Context remains above the compaction threshold because compaction did not complete` is defined by senpi's `RequiredCompactionError`, not found in the inspected Pi 1.1.0 distribution's 326 `.js` files or OMP 18.8.8's bundled `dist/cli.js`. OMO uses senpi; this is not evidence that OMO independently defines the error. Senpi has exceptions for cooldown, model-specific delegation, and superseding compaction claims (`agent-session.ts:7850-7853,8193-8205`); ordinary MC `{ cancel:true }` does not tell senpi that compaction has been delegated to an external owner for this model.

Senpi's built-in compaction policy uses an adaptive window ratio: a 400k window falls in the **0.70** band, potentially adjusted by previous compaction yield (`packages/coding-agent/src/core/extensions/builtin/compaction/policy.ts:41-80,106-122,170-181`). That supports the reported 280k trip point. It is not Pi's universal default: Pi's predicate is window minus effective reserve ([Pi compaction implementation:264-270](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/compaction/compaction.ts#L264-L270)). Senpi also has reserve-based core checks; the policy and the final admission check must not be assumed to be one calculation.

### Can refusal persist without MC's own trigger firing?

**Yes, on a mandatory-compaction host under the stated conditions:** the host's stored context remains over the threshold at which it requires compaction before another provider request; MC pressure stays below its effective floor with no other eligible trigger; MC keeps cancelling; no historian/marker or host delegation changes either state. No successful user response arrives to update pressure, so another identical send can repeat the same rejection indefinitely. The unconditional veto plus independent trigger still permits that cycle on master and on 0.44.4. This is a source-derived integration/liveness risk, not an observed infinite run or a newly demonstrated upstream Pi deadlock.

The real-host checks establish the cancellation consequence, not the reporter's complete divergent ledger. An additional actual-MC/senpi experiment that seeded low persisted pressure **did not** reproduce a never-firing trigger: startup reset the stale pressure and the historian fired at 101.8%; subsequent pressure was also high. Its prompts were still refused while the background historian attempted work. This matters: fire-and-forget scheduling alone does not guarantee the mandatory compaction turn has completed. The mock replied `isolated mock reply`, without the structured compartment ranges and content MC requires from a historian, so these runs do not establish successful marker publication.

**Recommendation for approval, not an implementation promise:** keep request pressure for normal MC scheduling, but treat a host's mandatory compaction demand as a distinct liveness obligation. On a supported mandatory-compaction integration, either (1) await one bounded, cancellable MC historian/marker pass and re-check host admission, or (2) do not veto native compaction when MC cannot make safe progress. A fired-but-unlanded background historian is not sufficient. Missing anchors, no eligible history, timeouts, historian failures, and in-flight work need explicit bounded outcomes. Do not synthesize a successful marker or hide uncovered history merely to unblock admission. Relying on senpi's model-specific external-owner delegation semantics needs a separate compatibility decision: those fork-specific semantics are not an upstream Pi API guarantee.

## 2. Host scheduler dependence

The claim that `fromHook:true` proves dependence on the host's scheduler confuses **origin metadata** with **scheduling**:

1. MC's `context` handler commits tagging/drop work, then calls `maybeFireHistorian` (`packages/pi-plugin/src/context-handler.ts:4423-4465`). The trigger evaluates MC pressure and eligible history, and starts `spawnPiHistorianRun` independently (`:6099-6123,6178-6210`). The host `session_before_compact` callback merely vetoes/permits native compaction.
2. This was already true in 0.44.4 (`v0.44.4:packages/pi-plugin/src/context-handler.ts:3411-3433,4825-4860`). `/ctx-wrapup` also invokes the MC historian directly (`v0.44.4:packages/pi-plugin/src/commands/ctx-wrapup.ts:468-470`; master `packages/pi-plugin/src/commands/ctx-wrapup.ts:457-492`).
3. MC writes native markers with the final `appendCompaction` argument set to `true` (`packages/pi-plugin/src/compaction-marker-manager-pi.ts:132-141`; tag `:93-102`). That becomes `fromHook` provenance. MC uses it with `details.source === "magic-context"` to recognize its own projected summary (`packages/pi-plugin/src/context-handler.ts:2304-2344`). A direct session-manager append can carry this flag without having been initiated by a host compaction hook.

Host `compaction.enabled:false` disables normal host auto-compaction, not the host's `context` event or the extension's direct marker API. Pi's automatic check returns early when disabled; manual `/compact` remains available ([Pi `agent-session.ts:2952-2956`][pi-session], [Pi compaction documentation:419-437][pi-compaction-doc]). OMP's normal threshold maintenance is similarly gated ([OMP maintenance:2634-2643][omp-maintenance]); its explicit rollover and overflow paths are not all equivalent to ordinary threshold compaction. Senpi also retains stuck-overflow recovery even with proactive compaction disabled (`agent-session.ts:8109-8111`).

**Real MC checks:** host auto-compaction disabled, two prompts, zero `session_before_compact` events, two context callbacks, and MC log lines showing `historian trigger fired` plus an actual child PID on both Pi 1.1.0 and OMP 18.8.8. This proves scheduling/spawning, **not** a completed historian summary or marker: the intentionally simple mock reply was not a valid historian document.

Caveats are MC-specific, not host-scheduler dependence: MC's own compaction-off mode, absent historian configuration, unresolved ordinal alignment, pressure/eligibility gates, a spent pass budget, or an in-flight run can suppress scheduling. Master also does not start the ordinary automatic historian in headless `ctx.hasUI === false` sessions (`context-handler.ts:6178-6180`). The RPC runs used hosts that exposed the UI context. No warning asserting “host compaction disabled stops MC” should be added; it would describe a coupling the code and runs contradict.

## 3. Marker anchoring and changes after 0.44.4

### Fixes present in the examined master

| Mechanism | 0.44.4 behavior / current correction | Fixing commit and regression evidence |
| --- | --- | --- |
| Event-message to native-entry ID alignment | The tag's fingerprint fallback leaves ambiguous duplicates unresolved (`v0.44.4:context-handler.ts:1540-1557,1582-1625`). Master validates the positional lane and uses unique message headers as ordered anchors; equal-length runs between anchors can retain IDs without pretending ambiguous insertions are resolvable (`packages/pi-plugin/src/context-handler.ts:1918-2068`). | [`dd8931434a6f501393590d642873d52aa817f6ef`](https://github.com/cortexkit/magic-context/commit/dd8931434a6f501393590d642873d52aa817f6ef), then [`d953e271f21a6ce40a2cb23e0cb13d2e30e0db1d`](https://github.com/cortexkit/magic-context/commit/d953e271f21a6ce40a2cb23e0cb13d2e30e0db1d). `pi-entry-alignment.test.ts`: “keeps the real ids of an identical pair between anchors when another extension appends a message”; partner: “leaves an identical pair unresolved when a message lands inside its run”. |
| Stored ordinals versus a shortened branch walk | The tag calls `findFirstKeptEntryId` with stored ordinals but no branch offset (`v0.44.4:pi-historian-runner.ts:1302-1308`). Master derives the offset from stored compartment end IDs on the same branch and validates available additional anchors (`packages/pi-plugin/src/pi-ordinal-alignment.ts:117-175,260-278`). The historian passes that offset into marker lookup (`pi-historian-runner.ts:1331-1349`). | [`47b3cd30a4193ebbf321a4d2ed11de88085986a5`](https://github.com/cortexkit/magic-context/commit/47b3cd30a4193ebbf321a4d2ed11de88085986a5), hardened by [`43c569e525091d92eed89b6d8b54f91f65b93e4f`](https://github.com/cortexkit/magic-context/commit/43c569e525091d92eed89b6d8b54f91f65b93e4f). `pi-ordinal-alignment.test.ts`: “measures the offset from the newest compartment's end and continues the stored numbering”, “places a pending compaction marker's stored ordinal on the branch”, and missing/disagreeing-anchor partners. These checks passed. |
| `/ctx-wrapup` marker branch reader | The tag treats `getBranch()` as `{entries}`, so real Pi/OMP array results become an empty branch (`v0.44.4:commands/ctx-wrapup.ts:606-615`). Master reads the actual array, fresh at marker time; unavailable/throwing/non-array results still safely return empty (`packages/pi-plugin/src/commands/ctx-wrapup.ts:629-648`). | [`977a3d8f5814f8c797fb71ad18ea4b206ec71923`](https://github.com/cortexkit/magic-context/commit/977a3d8f5814f8c797fb71ad18ea4b206ec71923). `commands/ctx-wrapup.test.ts:645-711`: “advances the marker to the branch entry after the wrapped range” and “keeps the marker waiting when the branch it reads is empty”. Both passed. |

The header-ID resolver and raw-ordinal marker resolver are distinct. Improving the former is not proof that every `firstKeptEntryId` stall is repaired. The ordinal fix translates MC's stored message sequence numbers into the current native branch's numbering after early entries disappear. It needs a trustworthy stored anchor still present in the active branch. A `/tree` branch before that anchor, an unreadable branch, conflicting anchors, or a synthetic folded tool-result boundary can still legitimately leave the marker pending (`pi-ordinal-alignment.ts:117-175,222-257`; `pi-historian-runner.ts:1892-1929`).

Their boundary-marker lookup can also wait on a folded tool-result slot: MC's raw-message conversion may synthesize a message ID for content with no separate native entry ID, so cutting past it could hide that content. The fixes address concrete failure mechanisms consistent with the report. They do **not** establish that today's resolver would map all 631 reporter messages, or that the reporter's particular stall at 372 has the same cause. The `10-message` wrapup claim was not reproduced, and a marker failure alone does not establish a ten-message chunk-size rule. Ask for the relevant branch, compartment boundary IDs/ordinals, chunk-selection logs, and historian output before attributing that symptom.

### Is “nearest resolvable ordinal ≤ target” safe?

Let the last fully summarized ordinal be `N`, so the intended first kept ordinal is `N+1`. Pi retains `firstKeptEntryId` **inclusively** and the following entries, not the entries preceding that ID (Pi 1.1.0 published `dist/core/session-manager.js:216-228`). MC presently searches at/after `N+1`; it refuses to advance past a synthetic folded tool-result slot that could hold uncovered content (`pi-historian-runner.ts:1913-1929`).

On a correctly aligned, ordered branch, choosing a real earlier entry `K ≤ N` is conservative about retaining history: it **does not hide the uncovered suffix** `N+1...`. Instead it retains already-summarized messages `K...N` alongside their summary. Native projection can duplicate **covered** history, unless MC subsequently removes/deduplicates those raw messages. Moving earlier does not by itself send uncovered messages twice. It also trims less stored history, so may fail to lower the host ledger enough to resolve mandatory compaction.

That is a narrower safety property than “a safe general fallback”. With unresolved coordinates, “nearest” is not proven; an existing newer marker may already supersede the proposed earlier cut. A partial-message boundary can leave uncovered blocks inside the same native entry. Current MC explicitly rejects that boundary (`compaction-marker-manager-pi.ts:64-73`), verifies the target compartment/entry, and drains only after fresh rendered coverage authorizes it (`context-handler.ts:6417-6443,8425-8435`). Moving **later** past real uncovered entries can hide them. Synthesizing an anchor without a host-supported entry/projection contract is not justified.

**Recommendation:** retain the new anchor/offset checks and visible pending state. If considering an earlier-anchor fallback, require proven branch-coordinate alignment and rendered coverage, specify deduplication and progress behavior, and preserve partial-message/tool-result fences. Do not use it as a substitute for the mandatory-compaction liveness decision above. Any further fallback is a proposed design change requiring Ufuk's approval.

## Isolated run evidence and verification limits

### Isolation and reproduction procedure

All host executions used a throwaway root, never the live user stores:

```text
R=/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/bg_cab7e584ef9bea4b
```

Each case had its own `HOME`, `CFFIXED_USER_HOME`, `TMPDIR`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `XDG_CACHE_HOME`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR`, `MAGIC_CONTEXT_LOG_PATH`, and `PI_CODING_AGENT_DIR`, all below `R`. The working directory and explicit session file were also below `R`. Provider credentials were removed from the child environment; the only provider key was a fake key for a loopback mock server. Hosts were installed below `R/hosts` with Bun 1.4.2, outside the repository's manifests/lockfile. Install postinstall blocks were not overridden. Pi ran with Node v26.10.0; OMP/senpi with Bun 1.4.2. An initial senpi Node-wrapper attempt was corrected to launch Bun directly so that the inspected PID was the actual host, not its launcher.

The disposable runner used RPC, an explicit extension, no discovered user extensions/skills, and a generated 20-message JSONL branch. The model had a 400,000-token window. Last assistant usage was deliberately 399,010 to cross host admission thresholds; mock subsequent usage was 337,680. This isolates cancellation behavior; it does **not** reconstruct the reporter's gpt-6.1-sol tokenizer, compressed request, or history. The cancellation extension returned `{cancel:true}`. For the disabled-auto-compaction cases, that veto was not returned by the probe: the actual built MC extension was loaded, with memory/embeddings/dreamer disabled and its own 20% threshold.

Captures are outside regenerable build directories: `R/<case>/{summary.json,audit.jsonl,stdout.jsonl,lsof.txt,lsof-end.txt,magic-context.log}` where applicable. Source snapshots and the disposable runner were used for investigation, not committed as product or test changes. The excerpts below persist the relevant evidence in this report even if throwaway files are later removed.

| Case / command used from the task worktree | Host PID | Prompts / context callbacks / compaction-hook calls | Result |
| --- | --- | --- | --- |
| `bun .cache/issue-652/host-probe.ts pi on` (`pi-on-cancel`) | 20284 | 2 / 2 / 1 | Both prompt responses successful, disposition `started`; 2 mock requests. |
| `bun .cache/issue-652/host-probe.ts omp on` (`omp-on-cancel`) | 21959 | 2 / 2 / 4 | Both prompt responses successful; 2 mock requests. |
| `bun .cache/issue-652/host-probe.ts pi off mc` (`pi-off-mc-held`) | 39148 | 2 / 2 / 0 | Actual MC historian child 39177 spawned; 4 total mock requests including child traffic. |
| `bun .cache/issue-652/host-probe.ts omp off mc` (`omp-off-mc-held`) | 39239 | 2 / 2 / 0 | Actual MC historian child 39305 spawned; 3 total mock requests including child traffic. |
| `bun .cache/issue-652/host-probe.ts senpi on` (`senpi-on-cancel-bun`) | 51116 | 2 / 2 / 2 | Both prompts refused; 2 native candidate-summary requests, not successful user turns. |

Selected output:

```text
Pi version: 1.1.0
{"type":"compaction_end","reason":"threshold","aborted":true,"willRetry":false}
prompt 1: success=true disposition=started
prompt 2: success=true disposition=started

OMP version: omp/18.8.8
{"type":"auto_compaction_end","action":"handoff","aborted":true,"willRetry":false}
prompt 1: success=true
prompt 2: success=true

Senpi version: 2026.10.10-6
{"type":"compaction_end","reason":"pre_prompt","aborted":true,"willRetry":false,
 "accepted":false,"rejectionCause":"cancelled-by-extension"}
prompt 1: success=false error="Context remains above the compaction threshold because compaction did not complete"
prompt 2: success=false error="Context remains above the compaction threshold because compaction did not complete"
```

Disabled-host-compaction MC log evidence (the hooks did not run):

```text
Pi:  historian trigger fired (reason=force_band) usage=103.2% — spawning subagent
Pi:  historian[first] spawned pid=39177 argv=14 args
OMP: historian trigger fired (reason=force_band) usage=101.8% — spawning subagent
OMP: historian[first] spawned pid=39305 argv=13 args
```

`/usr/sbin/lsof -p <actual host pid>` was captured at startup and after prompts, rejecting any `.db`/WAL/SHM descriptor outside the case root. Representative descriptor lines (root abbreviated as `R` **only in this excerpt**):

```text
node 20284 ... /R/pi-on-cancel/probe.db
bun  21959 ... /R/omp-on-cancel/agent/agent.db
bun  21959 ... /R/omp-on-cancel/agent/models.db
bun  21959 ... /R/omp-on-cancel/home/.omp/cache/legacy-pi-extension-cache.db
node 39148 ... /R/pi-off-mc-held/data/magic-context/context.db
bun  39239 ... /R/omp-off-mc-held/data/magic-context/context.db
bun  51116 ... /R/senpi-on-cancel-bun/probe.db
```

The OMP captures also list its throwaway skill-description database and WAL/SHM files. Historian child snapshots for 39177 and 39305 showed throwaway working directories and **no open `.db` descriptors at the startup snapshot**; that is not a continuous filesystem audit. The children inherited the isolated environment, and were aborted on host shutdown. No live-store path was opened, read, migrated, or written by this investigation. The synthetic `probe.db` is just an audit fixture; actual-MC cases additionally opened the real MC schema in the throwaway `context.db`.

### Existing regression checks

Bun 1.4.2 remote Linux run, isolated HOME/XDG/MC/host directories:

```sh
bun scripts/check-bun.mjs && BUN_JSC_useOMGJIT=0 bun test --parallel=1 --timeout 30000 \
  packages/pi-plugin/src/pi-entry-alignment.test.ts \
  packages/pi-plugin/src/pi-ordinal-alignment.test.ts \
  packages/pi-plugin/src/commands/ctx-wrapup.test.ts \
  packages/pi-plugin/src/compaction-marker-manager-pi.test.ts
```

Result: **47 passed, 1 failed; 160 assertions, 48 tests across four files.** No source/test files were changed. The baseline failure was `Pi ordinal alignment: the live context pass > the stuck session's historian resumes at 65939 on the first pass, with no repair step` (`pi-ordinal-alignment.test.ts:795`): expected the injected runner once, received zero calls. Its captured log already showed the correct `57992` offset and `historian trigger fired`, but execution had not reached the injected runner before the assertion. The cause of that failure was not established; asynchronous scheduling/preparation is a possible explanation, not a confirmed diagnosis. This is a verification gap, not evidence that the offset calculation or marker tests failed. No test was rewritten or marked failing to turn this baseline result green.

A subsequent narrower run used the same four files with `--test-name-pattern='Pi positional|Pi fallback|Pi header-anchored|Pi deferred|Pi /ctx-wrapup|Pi ordinal alignment: stored|Pi ordinal alignment: fail-closed'`: **46 passed, 0 failed, 155 assertions, 2 filtered out**, Bun 1.4.2. This intentionally excludes both live-context tests (the failing runner assertion and its passing unanchored-session partner); it verifies the deterministic identity/offset and marker checks, not the excluded end-to-end progress assertion.

No new supported-host defect was pinned in a new test. The existing partner tests check ambiguity/missing-anchor behavior and marker progress. Documentation-only delivery does not require a TypeScript build/typecheck; the supplied worktree preparation reported `bun run build` successful (11.0s), not independently rerun here.

## Recommended next steps

1. Keep the three already-merged ID/ordinal/wrapup fixes; compare a sanitized reporter branch against them before declaring the specific anchoring incident resolved.
2. Ask for the effective merged threshold mapping, model/input-limit resolution, paired MC trigger and senpi admission logs, active branch excerpt, and exact vendored extension/runtime revisions. A matching 120k token threshold overrides the 20% setting, and OMO 5.1.28's documented senpi -10 differs from the reported -6; both affect which behavior to investigate.
3. If senpi integration is approved, define required-compaction ownership and a bounded completion/fallback handshake. Do not treat a plain veto as acknowledgment of completed MC compaction, and do not depend on adjusting one percentage to reconcile distinct meters.
4. No host-auto-compaction dependency fix is warranted by upstream Pi/OMP evidence. Explain `fromHook` provenance and MC's own scheduling gates instead.

## Draft reply to the reporter

Thanks for the detailed logs. We checked MC 0.44.4 and current master, and separated upstream Pi, Oh My Pi, and the senpi runtime used by OMO.

The refusal text you quoted comes from senpi's required-compaction admission path. In our isolated checks, cancelling compaction on Pi 1.1.0 and Oh My Pi 18.8.8 did not refuse the next send; the same cancellation on senpi 2026.10.10-6 repeatedly refused the prompts. MC still cancels native compaction while its own compaction mode is enabled, so a host that requires a completed compaction can conflict with MC's separate request-pressure trigger. We have not reproduced your complete low-render/high-stored session state.

One configuration detail is important: a matching 120,000-token threshold overrides the percentage threshold. At a 300,000-token input limit that means a 40% execute threshold and a 38% proactive floor, rather than 20% and 18%. Please share the effective threshold configuration/resolution log so we can tell which applied to the 22% reading.

MC's historian is also scheduled from the context handler, not only from the host's compaction hook. We observed it spawning with host auto-compaction disabled on both upstream hosts. The marker's `fromHook:true` flag identifies extension-origin compaction; it does not mean the host scheduler started the historian.

Since 0.44.4, master has fixes for header-anchored entry-ID alignment, stored ordinal numbering when a branch loses early entries, and `/ctx-wrapup` reading Pi's actual branch array. Those address relevant anchoring failures, but without your branch excerpt we cannot say that every unmapped entry or the 10-message chunk symptom is resolved. An earlier kept-entry anchor preserves more raw history, potentially repeating already-summarized content; it is not automatically a reliable way to relieve host compaction pressure.

Senpi is a Pi fork that we do not officially support yet. We appreciate the compatibility report, but upstream Pi/Oh My Pi guarantees should not be assumed to cover it. Could you share a sanitized active-branch excerpt around the compartment end/kept-entry boundary, the paired trigger/admission logs, and the exact senpi and vendored MC revisions? OMO 5.1.28's release notes name senpi 2026.10.10-10, while this report names -6. Further changes to who owns required compaction, or how MC falls back when it cannot complete it, need approval from maintainer Ufuk; this investigation makes no commitment to one.

## Pinned host source index

- [Pi 1.1.0 release commit](https://github.com/earendil-works/pi/commit/abe508e1b89912adde45528136c3221eb69acdd7); [agent session][pi-session]; [compaction documentation][pi-compaction-doc]. Runtime check used the matching npm package.
- [OMP 18.8.8 release revision](https://github.com/can1357/oh-my-pi/commit/1ca13863a82825bdce02908b3db9713e9b084290); [session maintenance][omp-maintenance]. This is Oh My Pi, not Oh My OpenAgent.
- [senpi 2026.10.10-6 revision](https://github.com/code-yeongyu/senpi/commit/19c063a67e82d272a5566620fa7a94182d309a3a); [agent session][senpi-session]; [built-in compaction policy][senpi-policy]. Tag resolution was checked with `git ls-remote`.

[pi-session]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/agent-session.ts
[pi-compaction-doc]: https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/compaction.md
[omp-maintenance]: https://github.com/can1357/oh-my-pi/blob/1ca13863a82825bdce02908b3db9713e9b084290/packages/coding-agent/src/session/session-maintenance.ts
[senpi-session]: https://github.com/code-yeongyu/senpi/blob/19c063a67e82d272a5566620fa7a94182d309a3a/packages/coding-agent/src/core/agent-session.ts
[senpi-policy]: https://github.com/code-yeongyu/senpi/blob/19c063a67e82d272a5566620fa7a94182d309a3a/packages/coding-agent/src/core/extensions/builtin/compaction/policy.ts
