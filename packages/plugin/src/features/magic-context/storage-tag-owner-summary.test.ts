/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Database as UnwrappedDatabase } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, mayChangeTagIdentity } from "../../shared/sqlite";
import { contentTagOwnerMessageId } from "../../shared/tag-owner-id";
import { initializeDatabase } from "./storage-db";
import {
    backfillTagTokenCounts,
    deleteTagsByMessageId,
    getMaxTagNumberByOwnerMessage,
    getReasoningTokenEstimatesByMessage,
    getTagOwnerRowsReadForTest,
    getTagsBySession,
    insertTag,
    resetTagOwnerRowsReadForTest,
} from "./storage-tags";

const SESSION = "ses-tags";

/** The reasoning budget projection's owner grouping, computed from every tag as it used to be. */
function frozenMaxTagByOwner(db: Database, sessionId: string): Map<string, number> {
    const maxTags = new Map<string, number>();
    for (const tag of getTagsBySession(db, sessionId)) {
        const id =
            tag.type === "tool" ? tag.toolOwnerMessageId : contentTagOwnerMessageId(tag.messageId);
        if (id) maxTags.set(id, Math.max(maxTags.get(id) ?? 0, tag.tagNumber));
    }
    return maxTags;
}

/** The estimate statement as it was before the summary cache. */
function frozenReasoningEstimates(
    db: Database,
    sessionId: string,
    proseRatio: number,
): Map<string, number> {
    const rows = db
        .prepare(
            "SELECT type, message_id, tool_owner_message_id, reasoning_token_count FROM tags WHERE session_id = ? AND reasoning_token_count IS NOT NULL",
        )
        .all(sessionId) as Array<{ type: string; message_id: string; reasoning_token_count: number }>;
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
        reasoning === null ? null : { tokenCount: 5, inputTokenCount: 0, reasoningTokenCount: reasoning },
    );
}

describe("tag owner summary", () => {
    it("matches a full read through appends, owner changes, removals and other connections", () => {
        const directory = mkdtempSync(join(tmpdir(), "mc-tag-owner-"));
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
            // Another prose ratio is folded on demand.
            expectMatchesFullRead(db, 1.5);

            // A reasoning count written later changes an existing row.
            backfillTagTokenCounts(db, SESSION, 6, { tokenCount: 5, inputTokenCount: 0, reasoningTokenCount: 300 });
            expectMatchesFullRead(db);

            // A removal lowers an owner's maximum.
            deleteTagsByMessageId(db, SESSION, "m-3");
            expectMatchesFullRead(db);

            // An owner re-assignment through this process's connection.
            db.prepare("UPDATE tags SET tool_owner_message_id = ? WHERE session_id = ? AND tag_number = ?").run(
                "m-2",
                SESSION,
                4,
            );
            expectMatchesFullRead(db);

            // A commit by another process, invisible to this process's write count.
            other = new UnwrappedDatabase(path);
            other.exec("PRAGMA busy_timeout = 1000");
            other.prepare("DELETE FROM tags WHERE session_id = ? AND tag_number = ?").run(SESSION, 2);
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
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("reads only the appended tag rows, however many tags the session has", () => {
        const rowsReadFor = (tagCount: number): number => {
            const db = new Database(":memory:");
            try {
                initializeDatabase(db);
                db.transaction(() => {
                    for (let tag = 1; tag <= tagCount; tag += 1) {
                        addTag(db, tag, `m-${tag}`, tag % 3 === 0 ? "tool" : "message", tag, `m-${tag - 1}`);
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

describe("tag identity write classification", () => {
    it("lets appends and identity-free updates keep the summary", () => {
        for (const sql of [
            "INSERT INTO tags (session_id, message_id, type, byte_size, tag_number) VALUES (?, ?, ?, ?, ?)",
            "UPDATE tags SET status = ? WHERE session_id = ? AND tag_number = ?",
            "UPDATE tags SET drop_mode = ? WHERE session_id = ? AND tag_number = ?",
            "UPDATE tags SET token_count = MAX(COALESCE(token_count, 0), ?) WHERE session_id = ? AND tag_number = ?",
            "UPDATE tags\n SET byte_size = ?,\n reasoning_byte_size = ?,\n input_byte_size = ?\n WHERE session_id = ?",
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
