# Serving-thread stall cost: before and after

Driver: `scripts/perf-audit/stall-cost.ts`. Both runs used the same driver on
the same Linux build host, one after the other, in a throwaway root
(`/tmp/magic-context/bg_189551472f6f1b31`, with `XDG_*`, `HOME`,
`MAGIC_CONTEXT_STORAGE_DIR` and `OPENCODE_DB` pointed inside it). "Before" is
`packages/plugin/src` at 9d26c87081, extracted with `git archive`; "after" is
this branch, including the fixes from the independent review
(`docs/reports/oc-stall-fixes-review.md`). Every database the driver opened was
created under the root: `before-opencode.db`, `before-reasoning-context.db`,
`after-opencode.db`, `after-reasoning-context.db` and `search-context.db` (built
by the first run and searched by both). No OpenCode host was started.

Fixture: one OpenCode session of 150,000 messages (OpenCode 1.18.30 message/part
schema and indexes, four messages per timestamp, a compaction summary every
1,000th message); 300,020 tags for the reasoning budget (one message tag and one
tool tag per message), a live array of 2,000 messages and 1,000 frozen
merged-reasoning decisions; a 150,015-message LKG prefix.

| Stall | Measure | Before | After |
|---|---|---|---|
| Ordinal of an indexed message (`readRawSessionMessageByIdFromDb`) | first lookup of the session | 25.2 ms | 25.6 ms |
| | lookup right after appending that message, median of 20 | 22.5 ms | 22.0 ms |
| | same, max | 26.7 ms | 22.2 ms |
| | lookup with no write since the previous lookup, median of 20 | 22.0 ms | 0.05 ms |
| Explicit `ctx_search` with probes (message lane) | longest event-loop block | 137 ms | 3.9 ms (worker) |
| | total latency | 137 ms | 179 ms (worker start included) |
| keep_reasoning_tokens projection | first pass | 490 ms | 271 ms |
| | ordinary pass (2 tags appended), median of 10 | 357 ms | 1.29 ms |
| | compartment-trigger estimate read, median | 69.0 ms | 0.03 ms |
| LKG entry digests (`noteEntry`) | first pass | 5,047 ms | 2,712 ms |
| | ordinary pass (3 messages appended), median of 5 | 5,955 ms | 442 ms |

Equality checks in the same runs: the last ordinal was 149,870 in both; the
reasoning cutoff was 299,028 in both; the search returned the same ten message
ids in process and from the worker, and the same ids as before.

## The ordinal is not O(new) after a write

The first version of this change reused a remembered ordinal across writes and
looked up an appended message in about 0.1 ms. The review showed that this
returned wrong canonical ordinals when earlier rows changed behind the
remembered point (a delete without a removal event, a moved `time_created`, an
insert sorting before a timestamp tie, a summary rewritten to `finish: stop`,
another connection's commit). Wrong ordinals corrupt history references, so
the remembered count is now reused only while the store stamp
(`data_version`, `total_changes()`, `schema_version`) is unchanged, which proves
nothing in the store changed. After any write the whole prefix is counted again.

That count is one row-value range seek on `(session_id, time_created, id)`, but
it must read every earlier message's JSON to leave out finished compaction
summaries: about 22 ms at 150k messages, about the same as the old statement.
An index-only `COUNT(*)` over the same range takes about 4 ms but cannot tell
which rows are excluded summaries, so it cannot give the canonical ordinal on
its own. In a live host OpenCode commits between most incremental-index
lookups, so most of them pay the full count; lookups with no write in between
(for example `ctx_expand` resolving several messages) count only the rows
between the remembered point and the target.

## Other notes

- The remaining ordinary LKG pass time is walking and comparing 150k messages'
  content, which drift detection needs; only the 3 new messages are hashed.
- The search lane does the same work on the worker; the serving thread only
  posts the request and awaits the reply. A worker that does not report it is
  running within 400 ms, or does not answer within 30 s after that, is replaced
  by the in-process lane, and the fallback is logged and counted.
