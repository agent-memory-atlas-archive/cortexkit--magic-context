/// <reference types="bun-types" />

import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { ensureMessagesIndexed } from "./message-index";
import { unifiedSearch } from "./search";
import { initializeDatabase } from "./storage-db";

function messages() {
    return Array.from({ length: 30 }, (_, index) => ({
        ordinal: index + 1,
        id: `m-${index}`,
        role: "assistant",
        createdAt: index,
        parts: [
            {
                type: "text",
                text:
                    index % 2 === 0
                        ? `CommonTerm appears in row ${index}`
                        : `RareSymbolXyz is only in row ${index}`,
            },
        ],
    }));
}

function options(corpus: ReturnType<typeof messages>) {
    return {
        memoryEnabled: false,
        embeddingEnabled: false,
        sources: ["message"] as const,
        explicitSearch: true,
        readMessages: () => corpus,
    };
}

describe("probe count reuse", () => {
    it("counts a probe once and reuses it for the next search of the same corpus", async () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            const corpus = messages();
            ensureMessagesIndexed(db, "session", () => corpus);
            const first = await unifiedSearch(
                db,
                "session",
                "/repo",
                "CommonTerm RareSymbolXyz",
                options(corpus),
            );
            let countStatements = 0;
            const prepare = db.prepare.bind(db);
            db.prepare = ((sql: string) => {
                if (sql.includes("COUNT(*)") && sql.includes("message_history_fts")) {
                    countStatements += 1;
                }
                return prepare(sql);
            }) as typeof db.prepare;
            const second = await unifiedSearch(
                db,
                "session",
                "/repo",
                "CommonTerm RareSymbolXyz",
                options(corpus),
            );
            expect(countStatements).toBe(0);
            expect(second.map((result) => result.messageId)).toEqual(
                first.map((result) => result.messageId),
            );
        } finally {
            closeQuietly(db);
        }
    });

    it("runs a file-backed probe count off the serving connection and keeps the ranking", async () => {
        const directory = mkdtempSync(join(tmpdir(), "probe-count-"));
        const db = new Database(join(directory, "context.db"));
        try {
            initializeDatabase(db);
            const corpus = messages();
            ensureMessagesIndexed(db, "session", () => corpus);
            const inMemory = new Database(":memory:");
            initializeDatabase(inMemory);
            ensureMessagesIndexed(inMemory, "session", () => corpus);
            const expected = await unifiedSearch(
                inMemory,
                "session",
                "/repo",
                "CommonTerm RareSymbolXyz",
                options(corpus),
            );
            closeQuietly(inMemory);
            const worker = spyOn(Worker.prototype, "terminate");
            try {
                const ranked = await unifiedSearch(
                    db,
                    "session",
                    "/repo",
                    "CommonTerm RareSymbolXyz",
                    options(corpus),
                );
                expect(ranked.map((result) => result.messageId)).toEqual(
                    expected.map((result) => result.messageId),
                );
                const started = worker.mock.calls.length;
                expect(started).toBeGreaterThan(0);
                const repeated = await unifiedSearch(
                    db,
                    "session",
                    "/repo",
                    "CommonTerm RareSymbolXyz",
                    options(corpus),
                );
                expect(worker.mock.calls.length).toBe(started);
                expect(repeated.map((result) => result.messageId)).toEqual(
                    expected.map((result) => result.messageId),
                );
            } finally {
                worker.mockRestore();
            }
        } finally {
            closeQuietly(db);
        }
    });
});
