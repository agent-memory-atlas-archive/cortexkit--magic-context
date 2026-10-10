/**
 * Worker entry for the canonical-ordinal warm-up: scans one OpenCode session's
 * messages for compaction-summary rows on its own read-only connection, so the
 * serving thread never reads a whole session's message JSON. See
 * `raw-ordinal-warmup.ts` for the caller.
 */
import { parentPort, workerData } from "node:worker_threads";
import type { RawOrdinalWarmupInput, RawOrdinalWarmupReply } from "./raw-ordinal-warmup";

const port = parentPort;
if (!port) throw new Error("raw ordinal warm-up worker requires a parent port");
const input = workerData as RawOrdinalWarmupInput;
// Report that the thread runs before loading any module, so the caller's first
// deadline only has to cover thread start.
port.postMessage({ kind: "accepted" } satisfies RawOrdinalWarmupReply);
const [{ Database }, { scanRawSessionSummaryRows }] = await Promise.all([
    import("../../shared/sqlite"),
    import("./read-session-raw"),
]);
let db: InstanceType<typeof Database> | undefined;
try {
    db = new Database(input.path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 250");
    const scan = scanRawSessionSummaryRows(db, input.sessionId);
    port.postMessage({ kind: "scan", scan } satisfies RawOrdinalWarmupReply);
} catch (error) {
    port.postMessage({
        kind: "error",
        error: error instanceof Error ? error.message : String(error),
    } satisfies RawOrdinalWarmupReply);
} finally {
    db?.close();
    port.close();
}
