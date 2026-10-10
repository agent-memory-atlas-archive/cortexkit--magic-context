import { parentPort, workerData } from "node:worker_threads";
import { Database } from "../../shared/sqlite";
import { MESSAGE_FTS_SESSION_FILTER_SQL } from "./message-fts-session-filter";

interface CountRequest {
    path: string;
    sessionId: string;
    queries: string[];
    cutoff: number | null;
    dateRange: { from: number; to: number } | null;
    sessionFirst: boolean;
    /** Slot 0 is the completion flag. Slots 1..N are the exact counts. */
    counts: SharedArrayBuffer;
}

/**
 * Exact probe document frequencies on a connection this worker owns. The SQL is
 * the same statement the in-process count uses, so the weights and the ranked
 * order do not change. The worker never writes. Completion is a shared flag so
 * the caller can wait without running SQLite on its own thread.
 */
const request = workerData as CountRequest;
const slots = new Int32Array(request.counts);
const db = new Database(request.path, { readonly: true });
try {
    const cutoffSql =
        request.cutoff === null
            ? ""
            : " AND CAST(message_history_fts.message_ordinal AS INTEGER) <= ?";
    const joinSql =
        request.dateRange === null
            ? ""
            : ` JOIN message_fts_rowid_map AS map
                     ON map.session_id = message_history_fts.session_id
                    AND map.fts_rowid = message_history_fts.rowid`;
    const dateSql = request.dateRange === null ? "" : " AND map.message_time_ms BETWEEN ? AND ?";
    const sessionFilter =
        request.sessionFirst || request.dateRange !== null ? MESSAGE_FTS_SESSION_FILTER_SQL : "";
    const sql = request.queries
        .map(
            (_, index) =>
                `SELECT ${index} AS queryIndex, COUNT(*) AS count
                   FROM message_history_fts${joinSql}
                  WHERE ${sessionFilter}message_history_fts.session_id = ${index === 0 ? "?1" : "?"}
                    AND message_history_fts MATCH ?${dateSql}${cutoffSql}`,
        )
        .join("\nUNION ALL\n");
    const bindings: unknown[] = [];
    for (const query of request.queries) {
        bindings.push(request.sessionId, query.length === 0 ? "" : `content : (${query})`);
        if (request.dateRange) bindings.push(request.dateRange.from, request.dateRange.to);
        if (request.cutoff !== null) bindings.push(request.cutoff);
    }
    const rows = db.prepare(sql).all(...bindings) as Array<{
        queryIndex?: unknown;
        count?: unknown;
    }>;
    for (const row of rows) {
        if (
            typeof row.queryIndex === "number" &&
            row.queryIndex >= 0 &&
            row.queryIndex < request.queries.length &&
            typeof row.count === "number" &&
            Number.isSafeInteger(row.count) &&
            row.count >= 0
        ) {
            slots[row.queryIndex + 1] = row.count;
        }
    }
    Atomics.store(slots, 0, 1);
} catch {
    Atomics.store(slots, 0, 2);
} finally {
    Atomics.notify(slots, 0);
    db.close();
    parentPort?.close();
}
