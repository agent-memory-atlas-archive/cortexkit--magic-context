/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OPENCODE1_MESSAGE_PART_SCHEMA } from "../../features/magic-context/__tests__/opencode1-query-fixture";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { encodeOpenCodeMessagesToCk, resolveOrdinalsForModule } from "./module-wire";
import { readSessionChunk, setRawMessageProvider } from "./read-session-chunk";
import {
    forgetRawSessionOrdinalWatermark,
    readRawSessionMessageByIdFromDb,
    readRawSessionMessageOrdinalByIdFromDb,
    readRawSessionMessageOrdinalPageFromDb,
    readRawSessionMessagePageFromDb,
    readRawSessionMessagesFromDb,
} from "./read-session-raw";

const SESSION = "ses-stall-review";

// Keep the pre-watermark count independent of the optimized reader. Fixtures
// for this oracle contain valid JSON; malformed rows have a separate parity test.
const OLD_COUNT = `SELECT COUNT(*) AS ordinal FROM message
    WHERE session_id = ?
      AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
               AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')
      AND (time_created < ? OR (time_created = ? AND id <= ?))`;

function insert(
    db: Database,
    id: string,
    time: number,
    info: object = { role: "user" },
    session = SESSION,
): void {
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
        id,
        session,
        time,
        time,
        JSON.stringify(info),
    );
}

function oldOrdinal(db: Database, id: string, session = SESSION): number {
    const row = db
        .prepare("SELECT time_created FROM message WHERE session_id = ? AND id = ?")
        .get(session, id) as { time_created: number };
    return (
        db.prepare(OLD_COUNT).get(session, row.time_created, row.time_created, id) as {
            ordinal: number;
        }
    ).ordinal;
}

function expectOldOrdinal(db: Database, id: string, session = SESSION): void {
    const expected = oldOrdinal(db, id, session);
    expect({ id, ordinal: readRawSessionMessageByIdFromDb(db, session, id)?.ordinal }).toEqual({
        id,
        ordinal: expected,
    });
    expect(readRawSessionMessageOrdinalByIdFromDb(db, session, id)).toBe(expected);
}

type Edit = "delete-prefix" | "move-prefix" | "insert-before-tie" | "finish-summary";

function changeBehindWatermark(db: Database, edit: Edit): void {
    switch (edit) {
        case "delete-prefix":
            db.prepare("DELETE FROM message WHERE id = 'a'").run();
            break;
        case "move-prefix":
            db.prepare("UPDATE message SET time_created = 50 WHERE id = 'a'").run();
            break;
        case "insert-before-tie":
            insert(db, "b-before", 20);
            break;
        case "finish-summary":
            db.prepare("UPDATE message SET data = ? WHERE id = 'a'").run(
                JSON.stringify({ role: "assistant", summary: true, finish: "stop" }),
            );
            break;
    }
}

function prefixEdit(edit: Edit, invalidate: boolean): void {
    const db = new Database(":memory:");
    try {
        db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
        insert(
            db,
            "a",
            10,
            edit === "finish-summary"
                ? { role: "assistant", summary: true, finish: "length" }
                : { role: "user" },
        );
        insert(db, "b-watermark", 20);
        insert(db, "c", 30);
        expectOldOrdinal(db, "b-watermark");
        changeBehindWatermark(db, edit);
        if (invalidate) forgetRawSessionOrdinalWatermark(SESSION);
        expectOldOrdinal(db, "c");
    } finally {
        db.close();
    }
}

describe("stall review ordinal differential", () => {
    for (const edit of [
        "delete-prefix",
        "move-prefix",
        "insert-before-tie",
        "finish-summary",
    ] as const) {
        test(`${edit}: a surviving watermark must match the old count`, () =>
            prefixEdit(edit, false));
        test(`${edit}: explicit invalidation restores the old count`, () => prefixEdit(edit, true));
    }

    test("external-prefix-write: another indexer's commit must invalidate the watermark", () => {
        externalPrefixWrite(false);
    });
    test("external-prefix-write: reopening the reader restores canonical ordinals", () => {
        externalPrefixWrite(true);
    });

    test("two sessions, suffix revert and summary markers keep canonical ordinals", () => {
        const db = new Database(":memory:");
        try {
            db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
            insert(db, "a", 10);
            insert(db, "b", 20);
            insert(db, "other-a", 1, { role: "user" }, "ses-other-review");
            expectOldOrdinal(db, "b");
            expectOldOrdinal(db, "other-a", "ses-other-review");
            insert(db, "marker", 11, { role: "assistant", summary: true, finish: "stop" });
            insert(db, "c", 30);
            expectOldOrdinal(db, "c");
            db.prepare("DELETE FROM message WHERE id IN ('b', 'c')").run();
            insert(db, "d", 40);
            expectOldOrdinal(db, "d");
        } finally {
            db.close();
        }
    });
});

function externalPrefixWrite(reopen: boolean): void {
    const { dir, cleanup } = createTestTempDir("mc-stall-ordinal-review-");
    const path = join(dir, "opencode-fixture.db");
    let reader = new Database(path);
    const writer = new Database(path);
    try {
        reader.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
        reader.exec("PRAGMA journal_mode = WAL");
        insert(writer, "a", 10);
        insert(writer, "b", 20);
        expectOldOrdinal(reader, "b");
        insert(writer, "concurrent-before", 15);
        insert(writer, "c", 30);
        if (reopen) {
            reader.close();
            reader = new Database(path);
        }
        expectOldOrdinal(reader, "c");
    } finally {
        writer.close();
        reader.close();
        cleanup();
    }
}

function randomizedDifferential(invalidate: boolean): void {
    const db = new Database(":memory:");
    let seed = 0x5d0ee2b3;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed;
    };
    const mismatches: Array<{
        step: number;
        id: string;
        expected: number;
        point: number | undefined;
        ordinalOnly: number | null;
    }> = [];
    try {
        db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
        for (let index = 0; index < 32; index += 1)
            insert(db, `seed-${index}`, Math.floor(index / 4));
        insert(db, "tail", 1000);
        expectOldOrdinal(db, "tail");
        for (let step = 0; step < 80; step += 1) {
            const ids = (
                db
                    .prepare(
                        "SELECT id FROM message WHERE session_id = ? AND id != 'tail' ORDER BY id",
                    )
                    .all(SESSION) as Array<{ id: string }>
            ).map((row) => row.id);
            const victim = ids[random() % ids.length];
            switch (step % 4) {
                case 0:
                    insert(db, `insert-${step}`, random() % 12);
                    break;
                case 1:
                    db.prepare("DELETE FROM message WHERE id = ?").run(victim);
                    break;
                case 2:
                    db.prepare("UPDATE message SET time_created = ? WHERE id = ?").run(
                        random() % 2 ? 2000 : 1,
                        victim,
                    );
                    break;
                case 3:
                    db.prepare("UPDATE message SET data = ? WHERE id = ?").run(
                        JSON.stringify({ role: "assistant", summary: true, finish: "stop" }),
                        victim,
                    );
                    break;
            }
            if (invalidate) forgetRawSessionOrdinalWatermark(SESSION);
            const candidates = ["tail", `insert-${step - (step % 4)}`];
            for (const id of candidates) {
                const info = db.prepare("SELECT data FROM message WHERE id = ?").get(id) as {
                    data: string;
                } | null;
                if (!info || JSON.parse(info.data).summary === true) continue;
                const expected = oldOrdinal(db, id);
                const point = readRawSessionMessageByIdFromDb(db, SESSION, id)?.ordinal;
                const ordinalOnly = readRawSessionMessageOrdinalByIdFromDb(db, SESSION, id);
                if (point !== expected || ordinalOnly !== expected)
                    mismatches.push({ step, id, expected, point, ordinalOnly });
            }
        }
        expect(mismatches).toEqual([]);
    } finally {
        db.close();
    }
}

test("randomized differential: mixed prefix writes must preserve the old whole-session count", () => {
    randomizedDifferential(false);
});
test("randomized differential: invalidating each write matches the old whole-session count", () => {
    randomizedDifferential(true);
});

test("malformed earlier rows now consume an ordinal rather than throwing in the point lookup", async () => {
    const db = new Database(":memory:");
    try {
        db.exec(OPENCODE1_MESSAGE_PART_SCHEMA);
        insert(db, "a", 1);
        db.prepare("INSERT INTO message VALUES ('bad', ?, 2, 2, '{broken')").run(SESSION);
        insert(db, "c", 3);
        db.prepare("INSERT INTO part VALUES ('pc', 'c', ?, 3, 3, ?)").run(
            SESSION,
            JSON.stringify({ type: "text", text: "later valid message" }),
        );
        expect(() => oldOrdinal(db, "c")).toThrow();
        expect(readRawSessionMessageByIdFromDb(db, SESSION, "c")?.ordinal).toBe(3);
        expect(readRawSessionMessageOrdinalByIdFromDb(db, SESSION, "c")).toBe(3);
        expect(readRawSessionMessagesFromDb(db, SESSION).at(-1)?.ordinal).toBe(3);
        expect(readRawSessionMessagePageFromDb(db, SESSION, 0, 3).at(-1)?.ordinal).toBe(3);
        const release = setRawMessageProvider(SESSION, {
            readMessages: () => readRawSessionMessagesFromDb(db, SESSION),
            readMessagePage: (after, limit, final, anchor) =>
                readRawSessionMessagePageFromDb(db, SESSION, after, limit, final, anchor),
            readMessageOrdinalPage: (after, limit) =>
                readRawSessionMessageOrdinalPageFromDb(db, SESSION, after, limit),
            getMessageCount: () => 3,
            getStoredMessageCount: () => 3,
        });
        try {
            const resolved = await resolveOrdinalsForModule({
                sessionId: SESSION,
                messages: ["a", "c"].map((id) => ({ info: { id, role: "user" }, parts: [] })),
                generation: 1,
                memoGeneration: 0,
                memo: new Map(),
            });
            expect(resolved.ok).toBe(true);
            if (!resolved.ok) throw new Error("fixture failed to resolve CK ordinals");
            expect(
                encodeOpenCodeMessagesToCk(resolved.annotatedInput).map(
                    (message) => message.ordinal,
                ),
            ).toEqual([1, 3]);
            const chunk = readSessionChunk(SESSION, 1000, 3, 4, { expand: true });
            expect(chunk.startMessageId).toBe("c");
            expect(chunk.startIndex).toBe(3);
            expect(chunk.text).toContain("later valid message");
        } finally {
            release();
        }
    } finally {
        db.close();
    }
});
