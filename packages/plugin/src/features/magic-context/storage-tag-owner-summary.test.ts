/// <reference types="bun-types" />

import { Database as UnwrappedDatabase } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Database, mayChangeTagIdentity } from "../../shared/sqlite";
import { contentTagOwnerMessageId } from "../../shared/tag-owner-id";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { initializeDatabase } from "./storage-db";
import { installTagIdentityRevisionTrigger } from "./storage-tag-identity-revision";
import {
    backfillTagTokenCounts,
    deleteTagsByMessageId,
    getMaxTagNumberByOwnerMessage,
    getReasoningTokenEstimatesByMessage,
    getTagOwnerRowsReadForTest,
    getTagOwnerShapeChecksForTest,
    getTagsBySession,
    insertTag,
    resetTagOwnerRowsReadForTest,
    updateTagDropMode,
    updateTagStatus,
} from "./storage-tags";

const SESSION = "ses-tags";

/**
 * Highest tag number per owning message, read from every tag of the session:
 * a tool tag counts for its tool owner message (skipped without one), any other
 * tag for the message its content id names. This is how
 * projectOpencodeReasoningBudgetCutoff grouped tags before the summary cache.
 */
function frozenMaxTagByOwner(db: Database, sessionId: string): Map<string, number> {
    const maxTags = new Map<string, number>();
    for (const tag of getTagsBySession(db, sessionId)) {
        const id =
            tag.type === "tool" ? tag.toolOwnerMessageId : contentTagOwnerMessageId(tag.messageId);
        if (id) maxTags.set(id, Math.max(maxTags.get(id) ?? 0, tag.tagNumber));
    }
    return maxTags;
}

/**
 * Reasoning token estimate per owning message (the largest message-tag count
 * times the prose ratio), computed with the full-session statement that
 * getReasoningTokenEstimatesByMessage ran before the summary cache.
 */
function frozenReasoningEstimates(
    db: Database,
    sessionId: string,
    proseRatio: number,
): Map<string, number> {
    const rows = db
        .prepare(
            "SELECT type, message_id, tool_owner_message_id, reasoning_token_count FROM tags WHERE session_id = ? AND reasoning_token_count IS NOT NULL",
        )
        .all(sessionId) as Array<{
        type: string;
        message_id: string;
        reasoning_token_count: number;
    }>;
    const totals = new Map<string, number>();
    for (const row of rows) {
        if (row.type !== "message") continue;
        const id = contentTagOwnerMessageId(row.message_id);
        totals.set(id, Math.max(totals.get(id) ?? 0, row.reasoning_token_count * proseRatio));
    }
    return totals;
}

function expectMatchesFullRead(db: Database, ratio = 0.75): void {
    // Estimates first, as the projection reads them, then the owner map.
    expect(new Map(getReasoningTokenEstimatesByMessage(db, SESSION, ratio))).toEqual(
        frozenReasoningEstimates(db, SESSION, ratio),
    );
    expect(new Map(getMaxTagNumberByOwnerMessage(db, SESSION))).toEqual(
        frozenMaxTagByOwner(db, SESSION),
    );
}

function addTag(
    db: Database,
    tagNumber: number,
    messageId: string,
    type: "message" | "tool" | "file",
    reasoning: number | null = null,
    toolOwner: string | null = null,
): void {
    insertTag(
        db,
        SESSION,
        messageId,
        type,
        10,
        tagNumber,
        0,
        type === "tool" ? "read" : null,
        0,
        toolOwner,
        null,
        reasoning === null
            ? null
            : { tokenCount: 5, inputTokenCount: 0, reasoningTokenCount: reasoning },
    );
}

describe("tag owner summary", () => {
    it("matches a full read through appends, owner changes, removals and other connections", () => {
        const { dir: directory, cleanup } = createTestTempDir("mc-tag-owner-");
        const path = join(directory, "context.db");
        const db = new Database(path);
        // A connection opened without Magic Context's wrapper stands in for
        // another process: its writes reach this process only as a commit.
        let other: UnwrappedDatabase | undefined;
        try {
            initializeDatabase(db);
            addTag(db, 1, "m-1", "message", 40);
            addTag(db, 2, "m-1:p1", "message", 90);
            addTag(db, 3, "call-1", "tool", null, "m-1");
            addTag(db, 4, "call-2", "tool");
            addTag(db, 5, "m-2", "file");
            expectMatchesFullRead(db);

            // Appends are folded into the cached summary. Tag 6 is written before
            // its token columns exist, the way a legacy row is.
            addTag(db, 6, "m-3", "message", null);
            addTag(db, 7, "call-3", "tool", null, "m-3");
            expectMatchesFullRead(db);
            // A prose ratio the summary has not seen yet must still match a full read.
            expectMatchesFullRead(db, 1.5);

            // A reasoning count written later changes an existing row.
            backfillTagTokenCounts(db, SESSION, 6, {
                tokenCount: 5,
                inputTokenCount: 0,
                reasoningTokenCount: 300,
            });
            expectMatchesFullRead(db);

            // A removal lowers an owner's maximum.
            deleteTagsByMessageId(db, SESSION, "m-3");
            expectMatchesFullRead(db);

            // An owner re-assignment through this process's connection.
            db.prepare(
                "UPDATE tags SET tool_owner_message_id = ? WHERE session_id = ? AND tag_number = ?",
            ).run("m-2", SESSION, 4);
            expectMatchesFullRead(db);

            // A commit by another process, invisible to this process's write count.
            other = new UnwrappedDatabase(path);
            other.exec("PRAGMA busy_timeout = 1000");
            other
                .prepare("DELETE FROM tags WHERE session_id = ? AND tag_number = ?")
                .run(SESSION, 2);
            expectMatchesFullRead(db);

            // Rows read inside a transaction that rolls back never reach the cache.
            db.exec("BEGIN IMMEDIATE");
            addTag(db, 8, "m-9", "message", 999);
            expect(getMaxTagNumberByOwnerMessage(db, SESSION).get("m-9")).toBe(8);
            db.exec("ROLLBACK");
            expectMatchesFullRead(db);
        } finally {
            other?.close();
            db.close();
            cleanup();
        }
    });

    it("reads only the appended tag rows, however many tags the session has", () => {
        const rowsReadFor = (tagCount: number): number => {
            const db = new Database(":memory:");
            try {
                initializeDatabase(db);
                db.transaction(() => {
                    for (let tag = 1; tag <= tagCount; tag += 1) {
                        addTag(
                            db,
                            tag,
                            `m-${tag}`,
                            tag % 3 === 0 ? "tool" : "message",
                            tag,
                            `m-${tag - 1}`,
                        );
                    }
                })();
                getReasoningTokenEstimatesByMessage(db, SESSION, 1);
                getMaxTagNumberByOwnerMessage(db, SESSION);
                for (let tag = tagCount + 1; tag <= tagCount + 3; tag += 1) {
                    addTag(db, tag, `m-${tag}`, "message", tag);
                }
                resetTagOwnerRowsReadForTest();
                getReasoningTokenEstimatesByMessage(db, SESSION, 1);
                getMaxTagNumberByOwnerMessage(db, SESSION);
                const read = getTagOwnerRowsReadForTest();
                expectMatchesFullRead(db, 1);
                return read;
            } finally {
                db.close();
            }
        };
        expect(rowsReadFor(2_000)).toBe(3);
        expect(rowsReadFor(20_000)).toBe(3);
    });
});

describe("tag owner summary after other connections' commits", () => {
    /**
     * A file store with tags 1..count and a warm summary. `other` stands in for
     * another process: a connection without Magic Context's wrapper, whose
     * writes reach this process only as a commit (`data_version` moves).
     */
    /**
     * `other` is a Magic Context connection of another process by default: it
     * installs the identity-revision trigger every Magic Context connection
     * installs when it opens. `magicContextWriter: false` leaves it a raw
     * connection that is not Magic Context's.
     */
    function withForeignWriter(
        count: number,
        run: (db: Database, other: UnwrappedDatabase) => void,
        magicContextWriter = true,
    ): void {
        const { dir: directory, cleanup } = createTestTempDir("mc-tag-owner-foreign-");
        const path = join(directory, "context.db");
        const db = new Database(path);
        let other: UnwrappedDatabase | undefined;
        try {
            initializeDatabase(db);
            db.transaction(() => {
                for (let tag = 1; tag <= count; tag += 1)
                    addTag(
                        db,
                        tag,
                        `m-${tag}`,
                        tag % 3 === 0 ? "tool" : "message",
                        tag,
                        `m-${tag - 1}`,
                    );
            })();
            expectMatchesFullRead(db, 1);
            other = new UnwrappedDatabase(path);
            other.exec("PRAGMA busy_timeout = 1000");
            if (magicContextWriter) installTagIdentityRevisionTrigger(other as unknown as Database);
            run(db, other);
        } finally {
            other?.close();
            db.close();
            cleanup();
        }
    }

    function readCost(db: Database): { rows: number; checks: number } {
        resetTagOwnerRowsReadForTest();
        getReasoningTokenEstimatesByMessage(db, SESSION, 1);
        getMaxTagNumberByOwnerMessage(db, SESSION);
        return { rows: getTagOwnerRowsReadForTest(), checks: getTagOwnerShapeChecksForTest() };
    }

    it("folds tags another connection appended without rereading the session", () => {
        for (const count of [2_000, 20_000]) {
            withForeignWriter(count, (db, other) => {
                const insert = other.prepare(
                    "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number, reasoning_token_count) VALUES (?, ?, 'message', 10, ?, ?)",
                );
                for (let tag = count + 1; tag <= count + 3; tag += 1)
                    insert.run(SESSION, `m-${tag}`, tag, tag * 2);
                // One shape check, then only the three new rows.
                expect({ count, ...readCost(db) }).toEqual({ count, rows: 3, checks: 1 });
                expectMatchesFullRead(db, 1);
            });
        }
    });

    it("keeps the summary through status and drop writes on either connection", () => {
        withForeignWriter(2_000, (db, other) => {
            updateTagStatus(db, SESSION, 5, "dropped");
            updateTagDropMode(db, SESSION, 5, "truncated");
            expect(readCost(db)).toEqual({ rows: 0, checks: 0 });
            other
                .prepare(
                    "UPDATE tags SET status = 'dropped', drop_mode = 'full' WHERE session_id = ? AND tag_number <= 100",
                )
                .run(SESSION);
            expect(readCost(db)).toEqual({ rows: 0, checks: 1 });
            expectMatchesFullRead(db, 1);
        });
    });

    it("rebuilds after another connection deletes or replaces a tag", () => {
        withForeignWriter(2_000, (db, other) => {
            other
                .prepare("DELETE FROM tags WHERE session_id = ? AND tag_number = 1999")
                .run(SESSION);
            expect(readCost(db)).toEqual({ rows: 1_999, checks: 1 });
            expectMatchesFullRead(db, 1);
            // Delete and append in one commit: the count alone would not move.
            other.transaction(() => {
                other
                    .prepare("DELETE FROM tags WHERE session_id = ? AND tag_number = 1998")
                    .run(SESSION);
                other
                    .prepare(
                        "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, 'm-new', 'message', 10, 3000)",
                    )
                    .run(SESSION);
            })();
            expect(readCost(db)).toEqual({ rows: 1_999, checks: 1 });
            expectMatchesFullRead(db, 1);
            // A REPLACE removes the old row without a delete trigger.
            other
                .prepare(
                    "INSERT OR REPLACE INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, 'm-replaced', 'message', 10, 7)",
                )
                .run(SESSION);
            expect(readCost(db).rows).toBe(1_999);
            expectMatchesFullRead(db, 1);
        });
    });

    it("rebuilds after another Magic Context connection re-keys or backfills a tag in place", () => {
        withForeignWriter(2_000, (db, other) => {
            other
                .prepare(
                    "UPDATE tags SET message_id = 'm-rekeyed' WHERE session_id = ? AND tag_number = 1000",
                )
                .run(SESSION);
            expect(readCost(db)).toEqual({ rows: 2_000, checks: 1 });
            expectMatchesFullRead(db, 1);
            other
                .prepare(
                    "UPDATE tags SET reasoning_token_count = 5000 WHERE session_id = ? AND tag_number = 10",
                )
                .run(SESSION);
            expect(readCost(db)).toEqual({ rows: 2_000, checks: 1 });
            expectMatchesFullRead(db, 1);
        });
    });

    it("documents the residual: an in-place re-key by a connection that is not Magic Context's keeps the cached owners", () => {
        withForeignWriter(
            2_000,
            (db, other) => {
                other
                    .prepare(
                        "UPDATE tags SET message_id = 'm-rekeyed' WHERE session_id = ? AND tag_number = 1000",
                    )
                    .run(SESSION);
                // The raw connection does not bump the identity revision and the
                // count and highest id are unchanged, so the summary is kept. The
                // same re-key on this process's own connection moves its
                // identity-write generation and rebuilds.
                expect(readCost(db)).toEqual({ rows: 0, checks: 1 });
                expect(getMaxTagNumberByOwnerMessage(db, SESSION).get("m-rekeyed")).toBeUndefined();
                db.prepare(
                    "UPDATE tags SET message_id = 'm-rekeyed' WHERE session_id = ? AND tag_number = 1000",
                ).run(SESSION);
                expect(readCost(db).rows).toBe(2_000);
                expectMatchesFullRead(db, 1);
            },
            false,
        );
    });

    it("installs the identity-revision trigger on every initialized connection", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            expect(
                db
                    .prepare(
                        "SELECT name FROM sqlite_temp_master WHERE type = 'trigger' AND name = 'mc_tag_identity_revision_au'",
                    )
                    .get(),
            ).toEqual({ name: "mc_tag_identity_revision_au" });
        } finally {
            db.close();
        }
    });

    it("checks the session's shape from the index alone", () => {
        withForeignWriter(10, (db, other) => {
            other.prepare("UPDATE tags SET status = 'dropped' WHERE session_id = ?").run(SESSION);
            const statements: string[] = [];
            const prepare = db.prepare.bind(db);
            db.prepare = ((sql: string) => {
                statements.push(sql);
                return prepare(sql);
            }) as typeof db.prepare;
            try {
                expect(readCost(db).checks).toBe(1);
            } finally {
                db.prepare = prepare;
            }
            const shape = statements.find((sql) => sql.includes("COUNT(*)"));
            expect(shape).toBeDefined();
            const plan = (
                db
                    .prepare(`EXPLAIN QUERY PLAN ${shape}`)
                    .all(0, SESSION, `revision:${SESSION}`, SESSION) as Array<{
                    detail: string;
                }>
            ).map((row) => row.detail);
            // The appended rows come from the rowid range, the count and highest
            // id from an index without visiting the table.
            expect(plan.join(" | ")).toMatch(/SEARCH tags USING INTEGER PRIMARY KEY \(rowid>\?\)/);
            expect(plan.join(" | ")).toMatch(
                /SEARCH tags USING COVERING INDEX \w+ \(session_id=\?\)/,
            );
            expect(plan.join(" | ")).not.toMatch(/SCAN tags/);
        });
    });
});

describe("tag identity write classification", () => {
    it("lets appends and identity-free updates keep the summary", () => {
        for (const sql of [
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, ?, ?, ?)",
            "UPDATE tags SET status = ? WHERE session_id = ? AND tag_number = ?",
            "UPDATE tags SET drop_mode = ? WHERE session_id = ? AND tag_number = ?",
            "UPDATE tags SET token_count = MAX(COALESCE(token_count, 0), ?) WHERE session_id = ? AND tag_number = ?",
            "UPDATE tags\n SET byte_size = ?,\n reasoning_byte_size = ?,\n input_byte_size = ?\n WHERE session_id = ?",
            "UPDATE tags SET status = 'a, message_id = b', drop_mode = ? WHERE id = ?",
            "SELECT * FROM tags",
            "UPDATE notes SET content = ? WHERE id = ?",
            "DELETE FROM message_tags WHERE id = ?",
        ]) {
            expect({ sql, changes: mayChangeTagIdentity(sql) }).toEqual({ sql, changes: false });
        }
    });

    it("treats anything that can change or remove an existing tag as an identity write", () => {
        for (const sql of [
            "DELETE FROM tags WHERE session_id = ? AND tag_number = ?",
            "UPDATE tags SET message_id = ? WHERE session_id = ? AND tag_number = ?",
            "UPDATE tags SET tool_owner_message_id = ? WHERE id = ? AND tool_owner_message_id IS NULL",
            "UPDATE tags SET status = 'compacted', message_id = ?, entry_fingerprint = ? WHERE id = ?",
            "UPDATE tags SET token_count = CASE WHEN ? IS NOT NULL THEN MAX(COALESCE(token_count, 0), ?) ELSE token_count END, input_token_count = ?, reasoning_token_count = ? WHERE session_id = ?",
            "UPDATE tags SET status = ?",
            "UPDATE tags SET status = 'dropped', (tag_number, reasoning_token_count) = (6, 1000) WHERE id = ?",
            "UPDATE tags SET status = 'unbalanced WHERE id = ?",
            "UPDATE tags SET status == 1 WHERE id = ?",
            "UPDATE tags SET status = (SELECT 'x' WHERE 1) , message_id = ? WHERE id = ?",
            "INSERT OR REPLACE INTO tags (session_id, tag_number) VALUES (?, ?)",
            "INSERT INTO tags (id, session_id, tag_number) VALUES (?, ?, ?)",
            "INSERT INTO tags (session_id, tag_number) VALUES (?, ?) ON CONFLICT(session_id, tag_number) DO UPDATE SET message_id = excluded.message_id",
            "INSERT INTO tags (session_id) VALUES (?); DELETE FROM tags WHERE id = 1",
            "WITH doomed AS (SELECT id FROM tags) DELETE FROM tags WHERE id IN doomed",
            "DROP TABLE tags",
            "ALTER TABLE tags ADD COLUMN extra TEXT",
        ]) {
            expect({ sql, changes: mayChangeTagIdentity(sql) }).toEqual({ sql, changes: true });
        }
    });
});
