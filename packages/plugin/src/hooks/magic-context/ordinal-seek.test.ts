/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    type RawMessageOrdinalWatermark,
    readRawSessionMessageByIdFromDb,
    readRawSessionMessageOrdinalByIdFromDb,
    resetProvenRawSessionOrdinalsForTest,
} from "./read-session-raw";

/**
 * The ordinal query before the row-value seek. Frozen here, not imported from
 * the implementation, so a change in the new count cannot move both sides.
 */
const LEGACY_ORDINAL_SQL = `SELECT COUNT(*) AS ordinal FROM message
 WHERE session_id = ?
   AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
            AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')
   AND (time_created < ? OR (time_created = ? AND id <= ?))`;

function legacyOrdinal(db: Database, sessionId: string, id: string, timeCreated: number): number | null {
    try {
        const row = db.prepare(LEGACY_ORDINAL_SQL).get(sessionId, timeCreated, timeCreated, id) as {
            ordinal: number;
        };
        return row.ordinal;
    } catch {
        // The historical statement aborted on malformed JSON. The point lookup
        // caught that and returned no ordinal, which is the contract to match.
        return null;
    }
}

function createFixture(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id);
        CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
    `);
    return db;
}

describe("canonical ordinal seek", () => {
    it("matches the legacy count across summaries, equal timestamps and a revert", () => {
        resetProvenRawSessionOrdinalsForTest();
        const db = createFixture();
        try {
            const insert = db.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'session', ?, ?, ?)",
            );
            // Ids run backwards inside a shared timestamp. A comparison on either
            // column alone would assign a different ordinal than the legacy OR.
            const rows: Array<[string, number, string]> = [
                ["m-d", 20, JSON.stringify({ role: "user", text: "ordinary" })],
                ["m-c", 20, JSON.stringify({ role: "assistant", summary: true, finish: "stop" })],
                ["m-b", 20, JSON.stringify({ role: "assistant", summary: 1, finish: "stop" })],
                ["m-a", 20, JSON.stringify({ role: "user", summary: "true", finish: "stop" })],
                ["m-e", 30, "{"],
                ["m-f", 30, JSON.stringify({ role: "assistant", summary: true, finish: "length" })],
                ["m-g", 40, JSON.stringify({ role: "assistant", finish: "stop" })],
            ];
            for (const [id, time, data] of rows) insert.run(id, time, time, data);
            insert.run(
                "other",
                20,
                20,
                JSON.stringify({ role: "user" }),
            );
            db.prepare("UPDATE message SET session_id = 'other' WHERE id = 'other'").run();

            const summaryIds = new Set(["m-c"]);
            const numericSummaryIds = new Set(["m-b"]);
            const expectMatch = (id: string) => {
                const time = (
                    db.prepare("SELECT time_created FROM message WHERE id = ?").get(id) as {
                        time_created: number;
                    }
                ).time_created;
                const legacy = legacyOrdinal(db, "session", id, time);
                // Malformed JSON aborts the historical count, so this id and
                // every later id have no published ordinal.
                const expected = legacy === null ? null : legacy;
                if (summaryIds.has(id) || numericSummaryIds.has(id) || expected === null) {
                    expect(readRawSessionMessageOrdinalByIdFromDb(db, "session", id)).toBeNull();
                } else {
                    expect(readRawSessionMessageOrdinalByIdFromDb(db, "session", id)).toBe(
                        expected,
                    );
                }
                if (summaryIds.has(id) || expected === null) {
                    expect(readRawSessionMessageByIdFromDb(db, "session", id)).toBeNull();
                    return;
                }
                expect(readRawSessionMessageByIdFromDb(db, "session", id)?.ordinal).toBe(expected);
            };
            for (const [id] of rows) expectMatch(id);

            // A second lookup of the newest row must reuse the proven prefix.
            // The rows it reads are the gap, not the session.
            let rangedReads = 0;
            const prepare = db.prepare.bind(db);
            db.prepare = ((sql: string) => {
                const statement = prepare(sql);
                return new Proxy(statement, {
                    get(target, property) {
                        const value = Reflect.get(target, property);
                        if (property === "all" && sql.includes("(time_created, id) >")) {
                            return (...args: unknown[]) => {
                                const read = Reflect.apply(value, target, args) as unknown[];
                                rangedReads += read.length;
                                return read;
                            };
                        }
                        return typeof value === "function" ? value.bind(target) : value;
                    },
                });
            }) as typeof db.prepare;
            expectMatch("m-g");
            expect(rangedReads).toBeLessThan(rows.length);

            // A revert inserts a row before the proven watermark. The stored-row
            // count no longer matches, so the ordinal is classified again and
            // still agrees with the legacy count.
            insert.run("m-reverted", 10, 10, JSON.stringify({ role: "user", text: "restored" }));
            expectMatch("m-g");
            expect(readRawSessionMessageOrdinalByIdFromDb(db, "session", "m-reverted")).toBe(1);
        } finally {
            resetProvenRawSessionOrdinalsForTest();
            closeQuietly(db);
        }
    });

    it("does not read earlier message JSON once a watermark is proven", () => {
        resetProvenRawSessionOrdinalsForTest();
        const db = createFixture();
        try {
            const insert = db.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 's', ?, ?, ?)",
            );
            for (let index = 0; index < 40; index += 1) {
                insert.run(
                    `m-${index}`,
                    index,
                    index,
                    JSON.stringify({ role: "user", text: `body ${index}` }),
                );
            }
            const first = readRawSessionMessageByIdFromDb(db, "s", "m-39");
            expect(first?.ordinal).toBe(40);
            let prefixReads = 0;
            const prepare = db.prepare.bind(db);
            db.prepare = ((sql: string) => {
                const statement = prepare(sql);
                return new Proxy(statement, {
                    get(target, property) {
                        const value = Reflect.get(target, property);
                        if (
                            (property === "all" || property === "get") &&
                            sql.includes("(time_created, id) <=") &&
                            !sql.includes("(time_created, id) >")
                        ) {
                            return (...args: unknown[]) => {
                                prefixReads += 1;
                                return Reflect.apply(value, target, args);
                            };
                        }
                        return typeof value === "function" ? value.bind(target) : value;
                    },
                });
            }) as typeof db.prepare;
            insert.run("m-40", 40, 40, JSON.stringify({ role: "assistant", text: "new" }));
            const next = readRawSessionMessageByIdFromDb(db, "s", "m-40");
            expect(next?.ordinal).toBe(41);
            // One count proves the watermark and one records the new message.
            // Classifying the prefix again adds a third.
            expect(prefixReads).toBe(2);
        } finally {
            resetProvenRawSessionOrdinalsForTest();
            closeQuietly(db);
        }
    });

    it("accepts a caller watermark only while its stored-row count still holds", () => {
        const db = createFixture();
        try {
            const insert = db.prepare(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 's', ?, ?, ?)",
            );
            insert.run("early", 1, 1, JSON.stringify({ role: "user" }));
            insert.run("late", 2, 2, JSON.stringify({ role: "assistant" }));
            const watermark: RawMessageOrdinalWatermark = {
                id: "early",
                timeCreated: 1,
                ordinal: 1,
                data: JSON.stringify({ role: "user" }),
                storedRowsAtOrBefore: 1,
            };
            expect(readRawSessionMessageOrdinalByIdFromDb(db, "s", "late", watermark)).toBe(2);
            insert.run("between", 1, 1, JSON.stringify({ role: "user", text: "inserted" }));
            db.prepare("UPDATE message SET id = 'between' WHERE id = 'between'").run();
            // The stored-row proof fails, so the stale watermark is not added to.
            expect(readRawSessionMessageOrdinalByIdFromDb(db, "s", "late", watermark)).toBe(3);
        } finally {
            closeQuietly(db);
        }
    });
});
