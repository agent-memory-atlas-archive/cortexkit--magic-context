/**
 * Off-thread warm-up for canonical ordinal counts.
 *
 * Counting a session's canonical ordinals needs the ids of its compaction
 * summary rows (see `countCanonicalOrdinalsIndexed` in read-session-raw.ts).
 * Finding them the first time means reading every message's JSON once, which
 * takes seconds on a large, cold OpenCode store. This module does that scan on
 * a worker thread with its own read-only connection and installs the result on
 * the serving connection, so the serving thread only ever reads the rows added
 * since.
 *
 * Callers on the transform path await {@link prewarmRawSessionOrdinalsForDb}
 * before their synchronous counts. Background callers (message indexing)
 * reschedule when it reports "failed". A failed worker is not retried for the
 * same session until FAILURE_BACKOFF_MS has passed.
 */
import { Worker } from "node:worker_threads";
import { registerExitAbort } from "../../shared/exit-abort-registry";
import { log } from "../../shared/logger";
import { type Database, getSqliteDatabasePath } from "../../shared/sqlite";
import {
    countRawSessionMessageOrdinalsFromDb,
    countStoredRawSessionRowsIndexed,
    getRawSessionSummaryEpoch,
    installRawSessionSummaryScan,
    isRawSessionSummaryWarm,
    type RawSessionSummaryScan,
} from "./read-session-raw";

export interface RawOrdinalWarmupInput {
    path: string;
    sessionId: string;
}

export type RawOrdinalWarmupReply =
    | { kind: "accepted" }
    | { kind: "scan"; scan: RawSessionSummaryScan }
    | { kind: "error"; error: string };

/** "warm": counts of the session no longer scan it. "failed": the worker could not provide the scan. */
export type RawOrdinalWarmupOutcome = "warm" | "failed";

export type RawOrdinalWarmupFailureReason =
    | "start-failed"
    | "not-accepted"
    | "no-result"
    | "worker-error"
    | "exited"
    | "stopped"
    | "superseded";

export interface RawOrdinalWarmupOptions {
    entry?: URL;
    /** Sessions with at most this many stored messages are scanned on the calling thread. */
    inThreadMaxRows?: number;
    acceptMs?: number;
    resultMs?: number;
}

/** Scanning this many messages in-thread costs a few milliseconds warm and well under a second cold. */
const IN_THREAD_SCAN_MAX_ROWS = 2_000;
/** Thread start only: the worker reports before loading any module. */
const ACCEPT_TIMEOUT_MS = 2_000;
/** A cold scan of a session of hundreds of thousands of messages on a large store. */
const RESULT_TIMEOUT_MS = 10 * 60_000;
const FAILURE_BACKOFF_MS = 5 * 60_000;

const inFlight = new Map<string, Promise<RawOrdinalWarmupOutcome>>();
const failedAt = new Map<string, number>();
const activeWorkers = new Map<Worker, (reason: RawOrdinalWarmupFailureReason) => void>();
const failures = new Map<RawOrdinalWarmupFailureReason, number>();
let exitHookRegistered = false;

/** How often each reason left a session without an off-thread scan, in this process. */
export function getRawOrdinalWarmupFailures(): ReadonlyMap<RawOrdinalWarmupFailureReason, number> {
    return failures;
}

/** Stop every running warm-up worker; their callers see "failed". */
export function stopRawSessionOrdinalWarmups(): void {
    for (const stop of [...activeWorkers.values()]) stop("stopped");
}

/** @internal */
export function resetRawSessionOrdinalWarmupsForTest(): void {
    stopRawSessionOrdinalWarmups();
    inFlight.clear();
    failedAt.clear();
    failures.clear();
}

function defaultEntry(): URL {
    return new URL(
        new URL(import.meta.url).pathname.endsWith(".ts")
            ? "./raw-ordinal-warmup-worker.ts"
            : "./raw-ordinal-warmup-worker.js",
        import.meta.url,
    );
}

function ensureExitHook(): void {
    if (exitHookRegistered) return;
    exitHookRegistered = true;
    const controller = new AbortController();
    controller.signal.addEventListener("abort", stopRawSessionOrdinalWarmups, { once: true });
    registerExitAbort(controller);
}

function runWorker(
    input: RawOrdinalWarmupInput,
    options: RawOrdinalWarmupOptions,
): Promise<
    { scan: RawSessionSummaryScan } | { failure: RawOrdinalWarmupFailureReason; detail: string }
> {
    ensureExitHook();
    return new Promise((resolve) => {
        let worker: Worker | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (
            result:
                | { scan: RawSessionSummaryScan }
                | { failure: RawOrdinalWarmupFailureReason; detail: string },
        ) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            if (worker) {
                activeWorkers.delete(worker);
                void worker.terminate();
                worker.unref();
            }
            resolve(result);
        };
        const arm = (failure: RawOrdinalWarmupFailureReason, ms: number) => {
            clearTimeout(deadline);
            deadline = setTimeout(
                () => finish({ failure, detail: `no reply within ${ms} ms` }),
                ms,
            );
            deadline.unref?.();
        };
        try {
            worker = new Worker(options.entry ?? defaultEntry(), { workerData: input });
        } catch (error) {
            finish({ failure: "start-failed", detail: String(error) });
            return;
        }
        // Never keep the host process alive for a warm-up.
        worker.unref();
        activeWorkers.set(worker, (failure) => finish({ failure, detail: "stopped" }));
        arm("not-accepted", options.acceptMs ?? ACCEPT_TIMEOUT_MS);
        worker.on("message", (reply: RawOrdinalWarmupReply) => {
            if (reply.kind === "accepted") arm("no-result", options.resultMs ?? RESULT_TIMEOUT_MS);
            else if (reply.kind === "scan") finish({ scan: reply.scan });
            else finish({ failure: "worker-error", detail: reply.error });
        });
        worker.on("error", (error) => finish({ failure: "worker-error", detail: String(error) }));
        worker.on("exit", (code) => finish({ failure: "exited", detail: `exit code ${code}` }));
    });
}

/**
 * Make the next canonical count of `sessionId` on `db` free of a full scan.
 *
 * Already warm: returns at once. A store without a usable `message` table, an
 * in-memory store, or a session of at most `inThreadMaxRows` messages: scanned
 * here, which is bounded. Otherwise a worker scans the session and the result is
 * installed on `db`; rows written while it ran are picked up by the next count.
 * Concurrent calls for one session share one worker. "failed" means the worker
 * could not run or answer; it is logged, counted by reason, and not retried for
 * that session for FAILURE_BACKOFF_MS.
 */
export function prewarmRawSessionOrdinalsForDb(
    db: Database,
    sessionId: string,
    options: RawOrdinalWarmupOptions = {},
): Promise<RawOrdinalWarmupOutcome> {
    if (isRawSessionSummaryWarm(db, sessionId)) return Promise.resolve("warm");
    let storedRows: number;
    try {
        storedRows = countStoredRawSessionRowsIndexed(db, sessionId);
    } catch {
        // No OpenCode message table here: there is nothing to count or warm.
        return Promise.resolve("warm");
    }
    const path = getSqliteDatabasePath(db);
    if (!path || storedRows <= (options.inThreadMaxRows ?? IN_THREAD_SCAN_MAX_ROWS)) {
        countRawSessionMessageOrdinalsFromDb(db, sessionId);
        return Promise.resolve("warm");
    }
    const key = `${path}\0${sessionId}`;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const failed = failedAt.get(key);
    if (failed !== undefined && Date.now() - failed < FAILURE_BACKOFF_MS)
        return Promise.resolve("failed");
    const epoch = getRawSessionSummaryEpoch(sessionId);
    const started = performance.now();
    const work = runWorker({ path, sessionId }, options)
        .then((result): RawOrdinalWarmupOutcome => {
            let failure: RawOrdinalWarmupFailureReason;
            let detail: string;
            if ("scan" in result) {
                try {
                    if (installRawSessionSummaryScan(db, sessionId, result.scan, epoch)) {
                        failedAt.delete(key);
                        log(
                            `[magic-context] canonical ordinals of ${sessionId} warmed off-thread (${result.scan.sessionRows} messages, ${Math.round(performance.now() - started)} ms)`,
                        );
                        return "warm";
                    }
                } catch {
                    // The connection was closed or replaced while the worker ran.
                }
                failure = "superseded";
                detail =
                    "the session's summary rows were forgotten, or the connection changed, during the scan";
            } else {
                failure = result.failure;
                detail = result.detail;
            }
            failures.set(failure, (failures.get(failure) ?? 0) + 1);
            // A superseded scan is not a broken worker: the next call may try again.
            if (failure !== "superseded") failedAt.set(key, Date.now());
            log(
                `[magic-context] WARN canonical ordinal warm-up failed for ${sessionId} (${failure}: ${detail}); a count that needs it scans the session on the calling thread`,
            );
            return "failed";
        })
        .finally(() => inFlight.delete(key));
    inFlight.set(key, work);
    return work;
}
