# Serving-thread stall cost: before and after

Driver: `scripts/perf-audit/stall-cost.ts`. Both runs used the same driver on
the same Linux build host, one after the other, in a throwaway root
(`/tmp/magic-context/bg_189551472f6f1b31`, with `XDG_*`, `HOME`,
`MAGIC_CONTEXT_STORAGE_DIR` and `OPENCODE_DB` pointed inside it). "Before" is
`packages/plugin/src` at 9d26c87081, extracted with `git archive`; "after" is
this branch. Every database the driver opened was created under the root:
`before-opencode.db`, `before-reasoning-context.db`, `after-opencode.db`,
`after-reasoning-context.db` and `search-context.db` (built by the first run and
searched by both). No OpenCode host was started.

Fixture: one OpenCode session of 150,000 messages (OpenCode 1.18.30 message/part
schema and indexes, four messages per timestamp, a compaction summary every
1,000th message); 300,020 tags for the reasoning budget (one message tag and one
tool tag per message), a live array of 2,000 messages and 1,000 frozen
merged-reasoning decisions; a 150,015-message LKG prefix.

| Stall | Measure | Before | After |
|---|---|---|---|
| Ordinal of an indexed message (`readRawSessionMessageByIdFromDb`) | first lookup of the session | 21.5 ms | 37.0 ms |
| | lookup of a newly appended message, median of 20 | 20.9 ms | 0.11 ms |
| | same, max | 22.7 ms | 0.27 ms |
| Explicit `ctx_search` with probes (message lane) | longest event-loop block | 132 ms | 2.8 ms (worker) |
| | total latency | 132 ms | 193 ms (worker start included) |
| keep_reasoning_tokens projection | first pass | 540 ms | 321 ms |
| | ordinary pass (2 tags appended), median of 10 | 335 ms | 1.44 ms |
| | compartment-trigger estimate read, median | 57.6 ms | 0.02 ms |
| LKG entry digests (`noteEntry`) | first pass | 4,992 ms | 2,223 ms |
| | ordinary pass (3 messages appended), median of 5 | 6,581 ms | 473 ms |

Equality checks in the same runs: the last ordinal was 149,870 in both; the
reasoning cutoff was 299,028 in both; the search returned the same ten message
ids in process and from the worker, and the same ids as before.

Notes:

- The ordinal's first lookup counts the session once (one row-value range
  statement); later lookups count only the rows after the remembered watermark.
- The remaining ordinary LKG pass time is walking and comparing 150k messages'
  content, which drift detection needs; only the 3 new messages are hashed.
- The search lane does the same work on the worker; the serving thread only
  posts the request and awaits the reply.
