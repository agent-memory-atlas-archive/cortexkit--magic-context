import type { Database } from "../../shared/sqlite";

export interface RawMessageParts {
    id: string;
    role: string;
    parts: unknown[];
    createdAt?: number | null;
    version?: string | number | null;
    /** Native store row type when the host exposes one; intentionally absent on v1. */
    storeType?: string;
}

export interface RawMessage extends RawMessageParts {
    ordinal: number;
}

/** Strictly classify rows that carry no user/assistant narrative and may fill a range gap. */
export function isStrictGapHealingMessage(message: RawMessage): boolean {
    if (message.storeType === "synthetic") return true;
    let sawTool = false;
    for (const part of message.parts) {
        if (!part || typeof part !== "object" || Array.isArray(part)) return false;
        const record = part as Record<string, unknown>;
        const type = typeof record.type === "string" ? record.type : "";
        if (type === "tool" || type === "tool_use" || type === "tool_result") {
            sawTool = true;
            continue;
        }
        const text =
            typeof record.text === "string"
                ? record.text
                : typeof record.content === "string"
                  ? record.content
                  : "";
        if (text.trim().length > 0 || type.length > 0) return false;
    }
    return sawTool;
}

export interface RawMessageOrdinalAnchor {
    timeCreated: number;
    id: string;
}

/**
 * A proven point in the canonical ordinal space. `ordinal` is the watermark
 * message's own ordinal, so later lookups add only the eligible rows after it.
 */
export interface RawMessageOrdinalWatermark extends RawMessageOrdinalAnchor {
    ordinal: number;
    /**
     * `data` text of the watermark message when its ordinal was assigned.
     * A later lookup trusts the ordinal only while that row's text is unchanged,
     * which an index read can prove without parsing the prefix.
     */
    data?: string;
    /**
     * Stored message rows at or before the watermark, summaries included.
     * An insert before the watermark changes this count, so the ordinal is not
     * reused until the prefix is classified again.
     */
    storedRowsAtOrBefore?: number;
}

export interface RawMessageOrdinalEntry extends RawMessageOrdinalAnchor {
    contributesOrdinal: boolean;
    hasValidInfo: boolean;
}

interface RawMessageRow {
    id: string;
    data: string;
    time_created?: number;
    time_updated?: number;
}

interface RawPartRow {
    message_id: string;
    data: string;
    time_updated?: number;
}

/**
 * OpenCode message IDs are global primary keys and `part.message_id` references
 * that key. Unary `+` keeps the cross-session correctness filter but prevents
 * SQLite from choosing the session-only index instead of the bounded message-id
 * lookup. Keep the likelihood hint for planner versions that honor it.
 */
export const RAW_MESSAGE_PARTS_BY_ID_SQL =
    "SELECT message_id, data, time_updated FROM part WHERE +session_id = ? AND likelihood(message_id = ?, 0.000001) ORDER BY time_created ASC, id ASC";

interface OrdinalRow {
    ordinal?: number;
}

function isRawMessageRow(row: unknown): row is RawMessageRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return typeof candidate.id === "string" && typeof candidate.data === "string";
}

function isRawPartRow(row: unknown): row is RawPartRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return typeof candidate.message_id === "string" && typeof candidate.data === "string";
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(value);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

export function isRawCompactionSummaryInfo(info: unknown): boolean {
    if (info === null || typeof info !== "object" || Array.isArray(info)) return false;
    const candidate = info as Record<string, unknown>;
    return candidate.summary === true && candidate.finish === "stop";
}

function parseJsonUnknown(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function attachRawPartVersion(value: unknown, timeUpdated: number | undefined): unknown {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    if (typeof timeUpdated !== "number") return value;
    try {
        Object.defineProperty(value, "__magicContextPartUpdatedAt", {
            value: timeUpdated,
            enumerable: false,
            configurable: true,
        });
    } catch {
        // Non-extensible provider objects are rare; the recursive byte-length
        // fingerprint still catches content changes when metadata cannot attach.
    }
    return value;
}

export function readRawSessionMessagesFromDb(db: Database, sessionId: string): RawMessage[] {
    const messageRows = db
        .prepare(
            "SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(sessionId)
        .filter(isRawMessageRow);

    const partsByMessageId = new Map<string, unknown[]>();
    const partMessageBatchSize = 128;
    for (let offset = 0; offset < messageRows.length; offset += partMessageBatchSize) {
        const messageIds = messageRows
            .slice(offset, offset + partMessageBatchSize)
            .map((row) => row.id);
        if (messageIds.length === 0) continue;
        const placeholders = messageIds.map(() => "?").join(", ");
        const partRows = db
            .prepare(
                `SELECT message_id, data, time_updated
                 FROM part
                 WHERE +session_id = ?
                   AND likelihood(message_id IN (${placeholders}), 0.000001)
                 ORDER BY message_id ASC, time_created ASC, id ASC`,
            )
            .all(sessionId, ...messageIds)
            .filter(isRawPartRow);
        for (const part of partRows) {
            const list = partsByMessageId.get(part.message_id) ?? [];
            list.push(attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated));
            partsByMessageId.set(part.message_id, list);
        }
    }

    // Filter out compaction summary messages injected by magic-context.
    // These exist only for OpenCode's filterCompacted boundary and must not
    // be visible to historian, trigger evaluation, FTS indexing, or ctx_expand.
    const filtered = messageRows.filter(
        (row) => !isRawCompactionSummaryInfo(parseJsonRecord(row.data)),
    );

    return filtered.flatMap((row, index) => {
        const info = parseJsonRecord(row.data);
        if (!info) return [];
        const role = typeof info.role === "string" ? info.role : "unknown";
        return {
            ordinal: index + 1,
            id: row.id,
            role,
            parts: partsByMessageId.get(row.id) ?? [],
            createdAt: row.time_created ?? null,
            version: row.time_updated ?? null,
        };
    });
}

interface PagedRawMessageRow extends RawMessageRow {
    ordinal: number;
}

/**
 * Read one bounded page from the canonical raw-message ordinal space. Message
 * and part JSON parsing is limited to the requested page so background FTS work
 * cannot monopolize the event loop by hydrating an entire long session.
 */
export function readRawSessionMessagePageFromDb(
    db: Database,
    sessionId: string,
    afterOrdinal: number,
    limit: number,
    finalWatermark = Number.MAX_SAFE_INTEGER,
    after?: RawMessageOrdinalAnchor,
): RawMessage[] {
    const messageRows = readRawMessagePageRows(
        db,
        sessionId,
        afterOrdinal,
        limit,
        finalWatermark,
        after,
    );
    if (messageRows.length === 0) return [];

    const placeholders = messageRows.map(() => "?").join(", ");
    const partRows = db
        .prepare(
            `SELECT message_id, data, time_updated
             FROM part
             WHERE +session_id = ?
               AND likelihood(message_id IN (${placeholders}), 0.000001)
             ORDER BY message_id ASC, time_created ASC, id ASC`,
        )
        .all(sessionId, ...messageRows.map((row) => row.id))
        .filter(isRawPartRow);
    return assembleRawMessagePage(messageRows, partRows);
}

function readRawMessagePageRows(
    db: Database,
    sessionId: string,
    afterOrdinal: number,
    limit: number,
    finalWatermark: number,
    after?: RawMessageOrdinalAnchor,
): PagedRawMessageRow[] {
    const remaining = Math.max(0, Math.floor(finalWatermark) - Math.floor(afterOrdinal));
    const pageSize = Math.min(Math.max(1, Math.floor(limit)), remaining);
    if (pageSize === 0) return [];

    // The ordinal seek is needed only for the first page of a range. Later
    // pages resume after the last filtered row, including timestamp ties. The
    // redundant lower bound lets SQLite seek the session/time index before
    // evaluating the tie-break and JSON filter.
    const parameters: Array<string | number> = [sessionId];
    if (after) parameters.push(after.timeCreated, after.timeCreated, after.timeCreated, after.id);
    parameters.push(pageSize);
    if (!after) parameters.push(Math.max(0, Math.floor(afterOrdinal)));
    return db
        .prepare(
            `SELECT id, data, time_created, time_updated
             FROM message
             WHERE session_id = ?
                ${after ? "AND time_created >= ? AND (time_created > ? OR (time_created = ? AND id > ?))" : ""}
                AND NOT (
                   CASE WHEN json_valid(data) = 1
                        THEN COALESCE(json_extract(data, '$.summary'), 0)
                        ELSE 0 END = 1
                   AND CASE WHEN json_valid(data) = 1
                            THEN COALESCE(json_extract(data, '$.finish'), '')
                            ELSE '' END = 'stop'
               )
             ORDER BY time_created ASC, id ASC
             LIMIT ? ${after ? "" : "OFFSET ?"}`,
        )
        .all(...parameters)
        .filter(isRawMessageRow)
        .map(
            (row, index): PagedRawMessageRow => ({
                ...row,
                ordinal: Math.floor(afterOrdinal) + index + 1,
            }),
        );
}

function assembleRawMessagePage(
    messageRows: readonly PagedRawMessageRow[],
    partRows: readonly RawPartRow[],
): RawMessage[] {
    const partsByMessageId = new Map<string, unknown[]>();
    for (const part of partRows) {
        const list = partsByMessageId.get(part.message_id) ?? [];
        list.push(attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated));
        partsByMessageId.set(part.message_id, list);
    }

    return messageRows.map((row) => {
        const info = parseJsonRecord(row.data);
        return {
            ordinal: row.ordinal,
            id: row.id,
            role: typeof info?.role === "string" ? info.role : "unknown",
            parts: partsByMessageId.get(row.id) ?? [],
            createdAt: row.time_created ?? null,
            version: row.time_updated ?? null,
        };
    });
}

/** Longest text a summary page keeps from one text part or one tool key argument. */
export const RAW_SUMMARY_TEXT_MAX_CHARS = 8192;
const RAW_SUMMARY_ARG_MAX_CHARS = 512;

/** Tool input keys the `TC:` summary line reads (see extractToolCallSummaries). */
const RAW_SUMMARY_TOOL_INPUT_KEYS = [
    "description",
    "filePath",
    "path",
    "pattern",
    "query",
    "symbol",
    "module",
    "action",
] as const;

function summaryStringField(jsonPath: string): string {
    return `CASE WHEN json_type(data, '${jsonPath}') = 'text' THEN substr(json_extract(data, '${jsonPath}'), 1, ${RAW_SUMMARY_ARG_MAX_CHARS}) END`;
}

/**
 * Part projection for summary pages, computed inside SQLite so the JavaScript
 * heap never holds a whole tool output. A text part keeps its fields with the
 * text cut to RAW_SUMMARY_TEXT_MAX_CHARS. A tool part is rebuilt from its name,
 * call id, status, the input keys a `TC:` line uses, and the metadata
 * description; its output, full metadata (LSP diagnostics and the like), and
 * bulky inputs such as written file contents are never read into JavaScript.
 */
const RAW_SUMMARY_PART_DATA_SQL = `CASE
    WHEN json_extract(data, '$.type') = 'text'
        THEN json_set(data, '$.text', substr(json_extract(data, '$.text'), 1, ${RAW_SUMMARY_TEXT_MAX_CHARS}))
    ELSE json_object(
        'type', 'tool',
        'tool', ${summaryStringField("$.tool")},
        'callID', ${summaryStringField("$.callID")},
        'state', json_object(
            'status', ${summaryStringField("$.state.status")},
            'input', json_object(${RAW_SUMMARY_TOOL_INPUT_KEYS.map(
                (key) => `'${key}', ${summaryStringField(`$.state.input.${key}`)}`,
            ).join(", ")}),
            'metadata', json_object('description', ${summaryStringField("$.state.metadata.description")})
        )
    )
END`;

/**
 * Read one bounded page in the same ordinal space as
 * {@link readRawSessionMessagePageFromDb}, keeping only text and tool parts in
 * their summary projection. For callers that render `U:` / `TC:` lines and
 * never need tool outputs, reasoning, or file payloads: peak memory is one page
 * of small projected parts, whatever the session or tool-output size.
 */
export function readRawSessionMessageSummaryPageFromDb(
    db: Database,
    sessionId: string,
    afterOrdinal: number,
    limit: number,
    finalWatermark = Number.MAX_SAFE_INTEGER,
    after?: RawMessageOrdinalAnchor,
): RawMessage[] {
    const messageRows = readRawMessagePageRows(
        db,
        sessionId,
        afterOrdinal,
        limit,
        finalWatermark,
        after,
    );
    if (messageRows.length === 0) return [];

    const placeholders = messageRows.map(() => "?").join(", ");
    const partRows = db
        .prepare(
            `SELECT message_id, ${RAW_SUMMARY_PART_DATA_SQL} AS data, time_updated
             FROM part
             WHERE +session_id = ?
               AND likelihood(message_id IN (${placeholders}), 0.000001)
               AND json_valid(data) = 1
               AND json_extract(data, '$.type') IN ('text', 'tool')
             ORDER BY message_id ASC, time_created ASC, id ASC`,
        )
        .all(sessionId, ...messageRows.map((row) => row.id))
        .filter(isRawPartRow);
    return assembleRawMessagePage(messageRows, partRows);
}

export function countRawSessionMessageOrdinalsFromDb(db: Database, sessionId: string): number {
    const row = db
        .prepare(
            `SELECT COUNT(*) AS count
             FROM message
             WHERE session_id = ?
               AND NOT (
                   CASE WHEN json_valid(data) = 1
                        THEN COALESCE(json_extract(data, '$.summary'), 0)
                        ELSE 0 END = 1
                   AND CASE WHEN json_valid(data) = 1
                            THEN COALESCE(json_extract(data, '$.finish'), '')
                            ELSE '' END = 'stop'
               )`,
        )
        .get(sessionId) as { count?: number } | null;
    return typeof row?.count === "number" ? row.count : 0;
}

/**
 * Read the canonical raw-message ordinal space without loading or parsing part rows.
 * Keep the ordering, summary predicate, and malformed-message behavior identical to
 * `readRawSessionMessagesFromDb`; consumers compare these ordinals across passes.
 */
export function readRawSessionMessageIdOrdinalsFromDb(
    db: Database,
    sessionId: string,
): Map<string, number> {
    const messageRows = db
        .prepare(
            "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(sessionId)
        .filter(isRawMessageRow);
    const ordinalById = new Map<string, number>();
    let ordinal = 0;
    for (const row of messageRows) {
        const info = parseJsonRecord(row.data);
        if (isRawCompactionSummaryInfo(info)) continue;
        ordinal += 1;
        if (info) ordinalById.set(row.id, ordinal);
    }
    return ordinalById;
}

/** Hydrate only the requested range; malformed rows consume ordinals but have no id entry. */
export function readRawSessionMessageIdOrdinalsForRangeFromDb(
    db: Database,
    sessionId: string,
    fromOrdinal: number,
    toOrdinal: number,
): Map<string, number> {
    const from = Math.max(1, Math.floor(fromOrdinal));
    const to = Math.floor(toOrdinal);
    if (to < from) return new Map();
    const rows = db
        .prepare(`
        SELECT id, data FROM message WHERE session_id = ?
          AND CASE WHEN json_valid(data) THEN NOT (
            COALESCE(json_type(data, '$.summary'), '') = 'true'
            AND COALESCE(json_extract(data, '$.finish'), '') = 'stop'
          ) ELSE 1 END
        ORDER BY time_created, id LIMIT ? OFFSET ?
    `)
        .all(sessionId, to - from + 1, from - 1)
        .filter(isRawMessageRow);
    const result = new Map<string, number>();
    for (const [index, row] of rows.entries()) {
        if (parseJsonRecord(row.data)) result.set(row.id, from + index);
    }
    return result;
}

/** Read a keyset page used to incrementally maintain shadow message ordinals. */
export function readRawSessionMessageOrdinalPageFromDb(
    db: Database,
    sessionId: string,
    after: RawMessageOrdinalAnchor | null,
    limit: number,
): RawMessageOrdinalEntry[] {
    const pageSize = Math.max(1, Math.floor(limit));
    const rows = (
        after
            ? db
                  .prepare(
                      `SELECT id, data, time_created
                       FROM message
                       WHERE session_id = ?
                         AND (time_created, id) > (?, ?)
                       ORDER BY time_created ASC, id ASC
                       LIMIT ?`,
                  )
                  .all(sessionId, after.timeCreated, after.id, pageSize)
            : db
                  .prepare(
                      `SELECT id, data, time_created
                       FROM message
                       WHERE session_id = ?
                       ORDER BY time_created ASC, id ASC
                       LIMIT ?`,
                  )
                  .all(sessionId, pageSize)
    ).filter(isRawMessageRow);

    return rows.flatMap((row) => {
        if (typeof row.time_created !== "number") return [];
        const info = parseJsonRecord(row.data);
        return {
            id: row.id,
            timeCreated: row.time_created,
            contributesOrdinal: !isRawCompactionSummaryInfo(info),
            hasValidInfo: info !== null,
        };
    });
}

/** Count stored rows without inspecting message JSON, allowing the session-id index to answer it. */
export function countStoredRawSessionMessagesFromDb(db: Database, sessionId: string): number {
    const row = db
        .prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?")
        .get(sessionId) as { count?: number } | null;
    return typeof row?.count === "number" ? row.count : 0;
}

interface AnchorRow {
    time_created: number;
    id: string;
}

function isAnchorRow(row: unknown): row is AnchorRow {
    return (
        row !== null &&
        typeof row === "object" &&
        typeof (row as { time_created?: unknown }).time_created === "number" &&
        typeof (row as { id?: unknown }).id === "string"
    );
}

interface OrdinalTargetKey {
    timeCreated: number;
    id: string;
    summary: boolean;
    data?: string;
}

/**
 * Legacy ordinal SQL treated numeric `summary: 1` as a compaction summary and
 * boolean `summary: true` the same way. A text needle cannot tell those apart,
 * so only rows that mention a summary are parsed; ordinary rows count from the
 * index without a JSON read.
 */
const RAW_COMPACTION_SUMMARY_NEEDLE = '"summary"';

/**
 * Same predicate as the historical `COUNT(*)` ordinal, including its treatment
 * of numeric 1. Invalid JSON is not a summary. Callers that already parsed the
 * row should not pay for a second parse.
 */
/**
 * Rows the historical ordinal statement did not count. A compaction summary is
 * one. Malformed JSON made that statement abort, so the point lookup returned
 * no ordinal; counting the malformed row would publish a coordinate no caller
 * has served. Invalid JSON is therefore not an eligible row.
 */
export function isLegacyOrdinalExcludedRow(data: string): boolean {
    let parsed: unknown;
    try {
        parsed = JSON.parse(data);
    } catch {
        return true;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const info = parsed as { summary?: unknown; finish?: unknown };
    return (info.summary === true || info.summary === 1) && info.finish === "stop";
}

/** Malformed JSON made the historical count abort, so no later ordinal was published. */
export function isMalformedOrdinalRow(data: string): boolean {
    try {
        JSON.parse(data);
        return false;
    } catch {
        return true;
    }
}

export function isLegacyOrdinalCompactionSummary(data: string): boolean {
    return data.includes(RAW_COMPACTION_SUMMARY_NEEDLE) && isLegacyOrdinalExcludedRow(data);
}

function ordinalTargetKey(db: Database, sessionId: string, messageId: string): OrdinalTargetKey | null {
    const row = db
        .prepare(
            "SELECT id, time_created, data FROM message WHERE session_id = ? AND id = ? LIMIT 1",
        )
        .get(sessionId, messageId) as { id?: unknown; time_created?: unknown; data?: unknown } | null;
    if (typeof row?.id !== "string" || typeof row.time_created !== "number") return null;
    const data = typeof row.data === "string" ? row.data : "";
    return {
        id: row.id,
        timeCreated: row.time_created,
        summary: isLegacyOrdinalCompactionSummary(data),
        data,
    };
}

function storedRowsAtOrBefore(
    db: Database,
    sessionId: string,
    through: RawMessageOrdinalAnchor,
): number {
    const row = db
        .prepare(
            `SELECT COUNT(*) AS count FROM message
             WHERE session_id = ? AND (time_created, id) <= (?, ?)`,
        )
        .get(sessionId, through.timeCreated, through.id) as { count?: unknown } | null;
    return typeof row?.count === "number" ? row.count : 0;
}

function watermarkStillHolds(
    db: Database,
    sessionId: string,
    watermark: RawMessageOrdinalWatermark,
): boolean {
    if (!Number.isSafeInteger(watermark.ordinal) || watermark.ordinal < 1) return false;
    // Without the stored-row count an insert before the watermark is invisible,
    // and reusing the ordinal would publish the wrong coordinate.
    if (watermark.storedRowsAtOrBefore === undefined) return false;
    if (storedRowsAtOrBefore(db, sessionId, watermark) !== watermark.storedRowsAtOrBefore) {
        return false;
    }
    const row = db
        .prepare(
            "SELECT data FROM message WHERE session_id = ? AND id = ? AND time_created = ? LIMIT 1",
        )
        .get(sessionId, watermark.id, watermark.timeCreated) as { data?: unknown } | null;
    if (typeof row?.data !== "string") return false;
    if (watermark.data !== undefined) return row.data === watermark.data;
    return !isLegacyOrdinalCompactionSummary(row.data);
}

/**
 * Count canonical ordinals in an index range. The bounds are row-value seeks on
 * `(session_id, time_created, id)`, so the visited rows are exactly the range
 * and not the rest of the session.
 *
 * A cold range (no watermark) counts every stored row by the index, then
 * subtracts compaction summaries. Ordinary rows never match the summary text
 * needle, so their JSON is not parsed. A watermarked range is the messages
 * appended since the last proven ordinal; that span is small enough to classify
 * directly, which also counts a summary inserted before the watermark.
 */
function countEligibleOrdinalsBetween(
    db: Database,
    sessionId: string,
    after: RawMessageOrdinalWatermark | null,
    through: RawMessageOrdinalAnchor,
): number {
    if (!after) {
        const stored = db
            .prepare(
                `SELECT COUNT(*) AS count FROM message
                 WHERE session_id = ? AND (time_created, id) <= (?, ?)`,
            )
            .get(sessionId, through.timeCreated, through.id) as { count?: unknown } | null;
        const storedCount = typeof stored?.count === "number" ? stored.count : 0;
        if (storedCount === 0) return 0;
        const summaries = db
            .prepare(
                `SELECT data FROM message
                 WHERE session_id = ?
                   AND (time_created, id) <= (?, ?)
                   AND (instr(data, ?) > 0 OR json_valid(data) = 0)`,
            )
            .all(
                sessionId,
                through.timeCreated,
                through.id,
                RAW_COMPACTION_SUMMARY_NEEDLE,
            ) as Array<{ data?: unknown }>;
        let excluded = 0;
        for (const row of summaries) {
            if (typeof row.data !== "string") continue;
            // A malformed row aborted the historical count. Matching that means
            // this id, and every id after it, has no published ordinal.
            if (isMalformedOrdinalRow(row.data)) return Number.NaN;
            if (isLegacyOrdinalExcludedRow(row.data)) excluded += 1;
        }
        return storedCount - excluded;
    }
    const stored = db
        .prepare(
            `SELECT COUNT(*) AS count FROM message
             WHERE session_id = ?
               AND (time_created, id) > (?, ?)
               AND (time_created, id) <= (?, ?)`,
        )
        .get(sessionId, after.timeCreated, after.id, through.timeCreated, through.id) as {
        count?: unknown;
    } | null;
    const storedCount = typeof stored?.count === "number" ? stored.count : 0;
    if (storedCount === 0) return 0;
    const summaries = db
        .prepare(
            `SELECT data FROM message
             WHERE session_id = ?
               AND (time_created, id) > (?, ?)
               AND (time_created, id) <= (?, ?)
               AND (instr(data, ?) > 0 OR json_valid(data) = 0)`,
        )
        .all(
            sessionId,
            after.timeCreated,
            after.id,
            through.timeCreated,
            through.id,
            RAW_COMPACTION_SUMMARY_NEEDLE,
        ) as Array<{ data?: unknown }>;
    let excluded = 0;
    for (const row of summaries) {
        if (typeof row.data !== "string") continue;
        if (isMalformedOrdinalRow(row.data)) return Number.NaN;
        if (isLegacyOrdinalExcludedRow(row.data)) excluded += 1;
    }
    return storedCount - excluded;
}

const provenOrdinalWatermarks = new Map<string, RawMessageOrdinalWatermark>();

/**
 * Remember an ordinal this process has just assigned from the OpenCode store.
 * The next lookup for the same session adds only the rows after that message.
 * A revert, a restart, or a watermark row that no longer exists drops it; the
 * lookup then classifies the prefix again instead of publishing a stale count.
 */
export function noteProvenRawSessionOrdinal(
    sessionId: string,
    watermark: RawMessageOrdinalWatermark,
): void {
    if (!Number.isSafeInteger(watermark.ordinal) || watermark.ordinal < 1) return;
    const prior = provenOrdinalWatermarks.get(sessionId);
    if (
        prior &&
        (prior.timeCreated > watermark.timeCreated ||
            (prior.timeCreated === watermark.timeCreated && prior.id > watermark.id) ||
            prior.ordinal > watermark.ordinal)
    ) {
        return;
    }
    provenOrdinalWatermarks.set(sessionId, watermark);
}

export function forgetProvenRawSessionOrdinal(sessionId: string): void {
    provenOrdinalWatermarks.delete(sessionId);
}

/** @internal Test hook. Production lookups drop a stale watermark through {@link forgetProvenRawSessionOrdinal}. */
export function resetProvenRawSessionOrdinalsForTest(): void {
    provenOrdinalWatermarks.clear();
}

function provenWatermarkBefore(
    sessionId: string,
    target: RawMessageOrdinalAnchor,
): RawMessageOrdinalWatermark | undefined {
    const watermark = provenOrdinalWatermarks.get(sessionId);
    if (!watermark) return undefined;
    if (
        watermark.timeCreated < target.timeCreated ||
        (watermark.timeCreated === target.timeCreated && watermark.id < target.id)
    ) {
        return watermark;
    }
    return undefined;
}

function countCanonicalOrdinalThrough(
    db: Database,
    sessionId: string,
    messageId: string,
    watermark: RawMessageOrdinalWatermark | undefined,
    knownTarget?: OrdinalTargetKey,
): number | null {
    const target = knownTarget ?? ordinalTargetKey(db, sessionId, messageId);
    if (!target || target.summary) return null;
    // A caller-supplied watermark wins. Otherwise reuse an ordinal this process
    // assigned earlier in the session, but only while that row is still the
    // message it was. An insert before it, or a revert, fails that check and the
    // prefix is classified again.
    const candidate =
        watermark &&
        (watermark.timeCreated < target.timeCreated ||
            (watermark.timeCreated === target.timeCreated && watermark.id < target.id))
            ? watermark
            : provenWatermarkBefore(sessionId, target);
    const anchor = candidate && watermarkStillHolds(db, sessionId, candidate) ? candidate : null;
    if (candidate && !anchor) provenOrdinalWatermarks.delete(sessionId);
    const delta = countEligibleOrdinalsBetween(db, sessionId, anchor, target);
    const ordinal = (anchor?.ordinal ?? 0) + delta;
    if (!Number.isFinite(ordinal) || ordinal <= 0) return null;
    if (ordinal > 0 && knownTarget?.data !== undefined) {
        noteProvenRawSessionOrdinal(sessionId, {
            ...target,
            ordinal,
            data: knownTarget.data,
            storedRowsAtOrBefore: storedRowsAtOrBefore(db, sessionId, target),
        });
    }
    return ordinal > 0 ? ordinal : null;
}

/**
 * Read ONLY the eligible tail — messages at/after the last compartment boundary
 * — assigning them their correct ABSOLUTE ordinals (continuing from
 * `baseOrdinal`), and return the absolute session message count alongside.
 *
 * This is the O(tail) read: it never touches the ~63k pre-boundary rows that the
 * full reader scans just to recover the tail's ordinal base — a number the
 * compaction marker already stores (`end_message` ordinal + `end_message_id`
 * anchor). On a months-long session the full read is O(session) and grows
 * unbounded; this stays flat at the tail size.
 *
 * Anchor semantics: reads rows with `(time_created, id) >= anchor` (INCLUSIVE of
 * the boundary message), in the same sort order as the full reader, filters
 * compaction-summary rows identically, and numbers the kept messages
 * `baseOrdinal, baseOrdinal+1, …`. Including the anchor keeps
 * `messageIdAtOrdinal(baseOrdinal)` real (the full reader has it too) so
 * boundary-edge message ids match.
 *
 * Returns null when the anchor message id isn't found (deleted / legacy
 * compartment without `end_message_id`); the caller then falls back to the full
 * read. `absoluteMessageCount` = `baseOrdinal + (keptTail - 1)` = the exact
 * count the full reader would produce, so every absolute-ordinal consumer lines
 * up.
 */
export function readRawSessionTailFromDb(
    db: Database,
    sessionId: string,
    baseOrdinal: number,
    anchorMessageId: string,
): { messages: RawMessage[]; absoluteMessageCount: number } | null {
    const anchorRow = db
        .prepare("SELECT time_created, id, data FROM message WHERE id = ? AND session_id = ?")
        .get(anchorMessageId, sessionId);
    if (!isAnchorRow(anchorRow)) return null;

    // Defensive: if the anchor itself is a compaction-summary row, the ordinal
    // mapping is ill-defined — summary rows are filtered out BEFORE ordinal
    // assignment in the full numbering, so a summary anchor has no ordinal and
    // `baseOrdinal` cannot correspond to it. Unreachable from current callers
    // (compartment boundaries come from ordinal walks over non-summary rows),
    // but if it ever happens, bail to the full reader rather than produce an
    // off-by-one window.
    const anchorInfo = parseJsonRecord((anchorRow as { data?: string }).data ?? "");
    if (anchorInfo?.summary === true && anchorInfo?.finish === "stop") return null;

    const messageRows = db
        .prepare(
            `SELECT id, data, time_created, time_updated FROM message
             WHERE session_id = ?
               AND (time_created > ? OR (time_created = ? AND id >= ?))
             ORDER BY time_created ASC, id ASC`,
        )
        .all(sessionId, anchorRow.time_created, anchorRow.time_created, anchorRow.id)
        .filter(isRawMessageRow);

    // Identical compaction-summary filter to the full reader, applied BEFORE
    // ordinal assignment.
    const filtered = messageRows.filter((row) => {
        const info = parseJsonRecord(row.data);
        return !(info?.summary === true && info?.finish === "stop");
    });

    const ids = filtered.map((row) => row.id);
    const partsByMessageId = new Map<string, unknown[]>();
    if (ids.length > 0) {
        const CHUNK = 800;
        for (let i = 0; i < ids.length; i += CHUNK) {
            const slice = ids.slice(i, i + CHUNK);
            const placeholders = slice.map(() => "?").join(",");
            const partRows = db
                .prepare(
                    `SELECT message_id, data, time_updated FROM part WHERE +session_id = ? AND likelihood(message_id IN (${placeholders}), 0.000001) ORDER BY time_created ASC, id ASC`,
                )
                .all(sessionId, ...slice)
                .filter(isRawPartRow);
            for (const part of partRows) {
                const list = partsByMessageId.get(part.message_id) ?? [];
                list.push(attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated));
                partsByMessageId.set(part.message_id, list);
            }
        }
    }

    const messages: RawMessage[] = [];
    let ord = baseOrdinal;
    for (const row of filtered) {
        const info = parseJsonRecord(row.data);
        if (!info) {
            // Mirror the full reader: a malformed row keeps its ordinal slot but
            // yields no element.
            ord += 1;
            continue;
        }
        messages.push({
            ordinal: ord,
            id: row.id,
            role: typeof info.role === "string" ? info.role : "unknown",
            parts: partsByMessageId.get(row.id) ?? [],
            createdAt: row.time_created ?? null,
            version: row.time_updated ?? null,
        });
        ord += 1;
    }

    // ord now points one past the last assigned ordinal, so the absolute count is
    // ord - 1 (== baseOrdinal + keptIncludingMalformed - 1).
    return { messages, absoluteMessageCount: Math.max(0, ord - 1) };
}

/**
 * Minimal structural view of an in-memory transform message, extracted from
 * OpenCode's `MessageLike` by the caller. Kept dependency-free so this module
 * doesn't import the transform/tagging layer.
 */
export interface InMemoryMessageView {
    id: string;
    role: string;
    parts: unknown[];
    /** From the message `info` if present; used to mirror the DB summary filter. */
    summary?: boolean;
    finish?: string;
}

export interface InMemoryTailResult {
    messages: RawMessage[];
    absoluteMessageCount: number;
    /** True when the compaction anchor id was located within the array. */
    anchorFound: boolean;
}

/**
 * Extract the minimal structural view from OpenCode transform messages
 * (`args.messages`, MessageLike-shaped: `{ info, parts }`). Tolerates missing
 * fields — a message without a string id becomes an empty-id view, which
 * `buildInMemoryTailRawMessages` treats as a malformed row (ordinal slot kept,
 * no element), mirroring the DB reader.
 */
export function extractInMemoryMessageViews(
    messages: readonly { info?: unknown; parts?: unknown }[],
): InMemoryMessageView[] {
    return messages.map((m) => {
        const info = (m.info ?? {}) as Record<string, unknown>;
        return {
            id: typeof info.id === "string" ? info.id : "",
            role: typeof info.role === "string" ? info.role : "unknown",
            parts: Array.isArray(m.parts) ? m.parts : [],
            summary: info.summary === true ? true : undefined,
            finish: typeof info.finish === "string" ? info.finish : undefined,
        };
    });
}

/**
 * Build an absolute-ordinal `RawMessage[]` tail from the in-memory transform
 * messages (`args.messages`), mirroring {@link readRawSessionTailFromDb} so the
 * boundary resolver produces an identical result without any opencode.db read.
 *
 * OpenCode hands the transform the post-compaction-marker tail, i.e. the eligible
 * window, already parsed. Ordinals are anchored at the last compartment boundary:
 *
 * - If `anchorMessageId` is found at index k, that message IS the boundary
 *   (ordinal `lastCompartmentEnd`); messages k, k+1, … get ordinals
 *   `lastCompartmentEnd, lastCompartmentEnd+1, …`. Messages before k (compaction
 *   marker lag — already compartmentalized) are dropped, matching the DB tail
 *   which starts AT the anchor.
 * - If the anchor isn't present (it was a summary row OpenCode already filtered,
 *   or marker is ahead), the array is assumed to start at `lastCompartmentEnd+1`
 *   and ordinals run `lastCompartmentEnd+1, …`. `anchorFound=false` flags this so
 *   callers can choose the DB fallback if they don't trust the assumption.
 * - No compartments yet (#132): pass `lastCompartmentEnd=0`,
 *   `anchorMessageId=null` → ordinals from 1 over the whole array.
 *
 * Mirrors the DB reader's contracts: compaction-summary rows
 * (`summary===true && finish==='stop'`) are filtered BEFORE ordinal assignment;
 * a malformed message (no string id) keeps its ordinal slot but yields no element;
 * `absoluteMessageCount` equals what the DB reader would report for the same tail.
 *
 * Returns null when there are no usable messages.
 */
export function buildInMemoryTailRawMessages(args: {
    messages: readonly InMemoryMessageView[];
    lastCompartmentEnd: number;
    anchorMessageId: string | null;
}): InMemoryTailResult | null {
    const { messages, lastCompartmentEnd, anchorMessageId } = args;

    // Mirror the DB reader's compaction-summary filter, applied BEFORE ordinal
    // assignment. (These rows are normally already absent post-filterCompacted,
    // but filtering defensively keeps ordinals aligned if one slips through.)
    const filtered = messages.filter((m) => !(m.summary === true && m.finish === "stop"));
    if (filtered.length === 0) return null;

    let startIndex = 0;
    let baseOrdinal: number;
    let anchorFound = false;
    if (anchorMessageId) {
        const anchorIndex = filtered.findIndex((m) => m.id === anchorMessageId);
        if (anchorIndex >= 0) {
            anchorFound = true;
            startIndex = anchorIndex;
            baseOrdinal = lastCompartmentEnd; // the anchor row IS lastCompartmentEnd
        } else {
            // Anchor filtered out / marker ahead: assume array starts just past it.
            baseOrdinal = Math.max(1, lastCompartmentEnd + 1);
        }
    } else {
        // No-compartment (#132) case: whole array is eligible from ordinal 1.
        baseOrdinal = Math.max(1, lastCompartmentEnd + 1);
    }

    const out: RawMessage[] = [];
    let ord = baseOrdinal;
    for (let i = startIndex; i < filtered.length; i += 1) {
        const m = filtered[i];
        if (!m.id || typeof m.id !== "string") {
            // Mirror the DB reader: malformed row keeps its ordinal slot, no element.
            ord += 1;
            continue;
        }
        out.push({
            ordinal: ord,
            id: m.id,
            role: typeof m.role === "string" ? m.role : "unknown",
            parts: m.parts ?? [],
            version: null,
        });
        ord += 1;
    }

    return { messages: out, absoluteMessageCount: Math.max(0, ord - 1), anchorFound };
}

export function readRawSessionMessagePartsByIdFromDb(
    db: Database,
    sessionId: string,
    messageId: string,
    onQuery?: () => void,
): RawMessageParts | null {
    onQuery?.();
    const row = db
        .prepare(
            "SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? AND id = ?",
        )
        .get(sessionId, messageId) as RawMessageRow | null;
    if (!row || !isRawMessageRow(row) || typeof row.time_created !== "number") return null;

    const info = parseJsonRecord(row.data);
    if (!info || isRawCompactionSummaryInfo(info)) return null;
    onQuery?.();
    const partRows = db
        .prepare(RAW_MESSAGE_PARTS_BY_ID_SQL)
        .all(sessionId, messageId)
        .filter(isRawPartRow);
    return {
        id: row.id,
        role: typeof info.role === "string" ? info.role : "unknown",
        parts: partRows.map((part) =>
            attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated),
        ),
        createdAt: row.time_created,
        version: row.time_updated ?? null,
    };
}

/**
 * Resolve one message ID in the canonical raw-message ordinal space. Synthetic
 * compaction summaries are excluded so this count matches every module wire
 * ordinal and does not depend on the stored compartment basis.
 *
 * The count is the indexer's last proven ordinal plus the eligible rows strictly
 * after that watermark and through the target. A row-value range seeks the
 * `(session_id, time_created, id)` index instead of JSON-parsing every earlier
 * message. Without a watermark the same count still holds, but the prefix has
 * to be classified once.
 */
export function readRawSessionMessageOrdinalByIdFromDb(
    db: Database,
    sessionId: string,
    messageId: string,
    watermark?: RawMessageOrdinalWatermark,
): number | null {
    return countCanonicalOrdinalThrough(db, sessionId, messageId, watermark);
}

export function readRawSessionMessageByIdFromDb(
    db: Database,
    sessionId: string,
    messageId: string,
    watermark?: RawMessageOrdinalWatermark,
): RawMessage | null {
    const row = db
        .prepare(
            "SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? AND id = ?",
        )
        .get(sessionId, messageId) as RawMessageRow | null;
    if (!row || !isRawMessageRow(row) || typeof row.time_created !== "number") {
        return null;
    }

    const info = parseJsonRecord(row.data);
    if (!info || isRawCompactionSummaryInfo(info)) {
        return null;
    }

    const ordinal = countCanonicalOrdinalThrough(db, sessionId, messageId, watermark, {
        timeCreated: row.time_created,
        id: row.id,
        summary: false,
        data: row.data,
    });
    if (ordinal === null) {
        return null;
    }

    const partRows = db
        .prepare(RAW_MESSAGE_PARTS_BY_ID_SQL)
        .all(sessionId, messageId)
        .filter(isRawPartRow);

    const role = typeof info.role === "string" ? info.role : "unknown";
    return {
        ordinal,
        id: row.id,
        role,
        parts: partRows.map((part) =>
            attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated),
        ),
        createdAt: row.time_created,
        version: row.time_updated ?? null,
    };
}

/** Existence does not require a canonical ordinal or any part payloads. */
export function hasRawSessionMessageByIdFromDb(
    db: Database,
    sessionId: string,
    messageId: string,
): boolean {
    const row = db
        .prepare("SELECT id, data, time_created FROM message WHERE session_id = ? AND id = ?")
        .get(sessionId, messageId) as RawMessageRow | null;
    if (!row || !isRawMessageRow(row) || typeof row.time_created !== "number") return false;
    const info = parseJsonRecord(row.data);
    if (!info || isRawCompactionSummaryInfo(info)) return false;
    // The legacy ordinal SQL also excludes numeric summary=1. Preserve its
    // unusual point-lookup behavior for those rows without taxing ordinary ids.
    if (info.summary === 1 && info.finish === "stop")
        return readRawSessionMessageByIdFromDb(db, sessionId, messageId) !== null;
    return true;
}

/** Read the canonical servable tail and its parts in one query, including its boundary row. */
export function readRawSeedTailFromDb(
    db: Database,
    sessionId: string,
    boundaryId: string | null,
): Map<string, RawMessage> {
    const rows = db
        .prepare(`
        WITH canonical AS (
            SELECT id, time_created,
                   ROW_NUMBER() OVER (ORDER BY time_created, id) AS ordinal
            FROM message WHERE session_id = ?
              AND NOT (CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.summary'), 0) ELSE 0 END = 1
                AND CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.finish'), '') ELSE '' END = 'stop')
        )
        SELECT c.id, m.data, c.time_created, m.time_updated, c.ordinal,
               p.data AS part_data, p.time_updated AS part_updated
        FROM canonical c JOIN message m ON m.id = c.id
        LEFT JOIN part p ON +p.session_id = ? AND likelihood(p.message_id = c.id, 0.000001)
        WHERE ? IS NULL OR c.ordinal >= (SELECT ordinal FROM canonical WHERE id = ?)
        ORDER BY c.ordinal, p.time_created, p.id
    `)
        .all(sessionId, sessionId, boundaryId, boundaryId) as Array<
        RawMessageRow & { ordinal: number; part_data: string | null; part_updated: number | null }
    >;
    const messages = new Map<string, RawMessage>();
    for (const row of rows) {
        if (!messages.has(row.id)) {
            const info = parseJsonRecord(row.data);
            if (!info) continue;
            messages.set(row.id, {
                id: row.id,
                ordinal: row.ordinal,
                role: typeof info.role === "string" ? info.role : "unknown",
                createdAt: row.time_created,
                version: row.time_updated,
                parts: [],
            });
        }
        if (row.part_data !== null)
            messages
                .get(row.id)
                ?.parts.push(
                    attachRawPartVersion(
                        parseJsonUnknown(row.part_data),
                        row.part_updated ?? undefined,
                    ),
                );
    }
    if (boundaryId !== null && !messages.has(boundaryId))
        throw new Error("state_sync materialized boundary is missing from raw storage");
    return messages;
}
