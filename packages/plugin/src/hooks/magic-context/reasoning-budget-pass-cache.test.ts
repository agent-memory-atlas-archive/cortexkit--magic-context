/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { insertTag } from "../../features/magic-context/storage-tags";
import { projectOpencodeReasoningBudgetCutoff } from "./reasoning-budget";
import type { MessageLike } from "./tag-messages";

function assistant(id: string, text: string): MessageLike {
    return {
        info: { id, role: "assistant", tokens: { reasoning: 10 } },
        parts: [{ type: "reasoning", thinking: text }],
    } as MessageLike;
}

describe("reasoning budget pass cache", () => {
    it("does not reload session tags on a second pass with no tag write", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            const sessionId = "session";
            db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run(sessionId);
            for (let index = 0; index < 20; index += 1) {
                insertTag(
                    db,
                    sessionId,
                    `m-${index}`,
                    "message",
                    10,
                    index + 1,
                    0,
                    null,
                    0,
                    null,
                    null,
                    { tokenCount: 10, inputTokenCount: 0, reasoningTokenCount: 10 },
                );
            }
            const messages = Array.from({ length: 20 }, (_, index) =>
                assistant(`m-${index}`, "thinking"),
            );
            const first = projectOpencodeReasoningBudgetCutoff(
                db,
                sessionId,
                messages,
                100,
                0,
                1,
            );
            let tagReads = 0;
            const prepare = db.prepare.bind(db);
            db.prepare = ((sql: string) => {
                if (sql.includes("FROM tags")) tagReads += 1;
                return prepare(sql);
            }) as typeof db.prepare;
            const second = projectOpencodeReasoningBudgetCutoff(
                db,
                sessionId,
                messages,
                100,
                0,
                1,
            );
            expect(second).toBe(first);
            expect(tagReads).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });
});
