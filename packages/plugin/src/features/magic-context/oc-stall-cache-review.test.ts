/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { join } from "node:path";
import { projectOpencodeReasoningBudgetCutoff } from "../../hooks/magic-context/reasoning-budget";
import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { initializeDatabase } from "./storage-db";
import { getReasoningTokenEstimatesByMessage, insertTag } from "./storage-tags";

const SESSION = "ses-stall-cache-review";
const messages: MessageLike[] = ["old", "new"].map(
    (id) =>
        ({
            info: { id, role: "assistant", tokens: { reasoning: 100 } },
            parts: [{ type: "reasoning", text: "visible thought" }],
        }) as unknown as MessageLike,
);

function seed(db: Database): void {
    initializeDatabase(db);
    for (const [id, tag] of [
        ["old", 5],
        ["new", 10],
    ] as const) {
        insertTag(db, SESSION, id, "message", 10, tag, 10, null, 0, null, null, {
            tokenCount: 5,
            inputTokenCount: 0,
            reasoningTokenCount: 100,
        });
    }
    expect(projectOpencodeReasoningBudgetCutoff(db, SESSION, messages, 100, 0, 1)).toBe(5);
    expect(getReasoningTokenEstimatesByMessage(db, SESSION, 1).get("old")).toBe(100);
}

function expectCommittedProjection(db: Database): void {
    const row = db
        .prepare(
            "SELECT tag_number, reasoning_token_count FROM tags WHERE session_id = ? AND message_id = 'old'",
        )
        .get(SESSION) as { tag_number: number; reasoning_token_count: number };
    expect(row).toEqual({ tag_number: 6, reasoning_token_count: 1000 });
    expect(projectOpencodeReasoningBudgetCutoff(db, SESSION, messages, 100, 0, 1)).toBe(6);
    expect(getReasoningTokenEstimatesByMessage(db, SESSION, 1).get("old")).toBe(1000);
}

const UPDATE_RETURNING =
    "UPDATE tags SET tag_number = 6, reasoning_token_count = 1000 WHERE session_id = ? AND message_id = 'old' RETURNING tag_number";

test("iterate write: consuming UPDATE RETURNING must refresh the reasoning cutoff", () => {
    const db = new Database(":memory:");
    try {
        seed(db);
        expect([...db.prepare(UPDATE_RETURNING).iterate(SESSION)]).toEqual([{ tag_number: 6 }]);
        expectCommittedProjection(db);
    } finally {
        db.close();
    }
});
test("iterate write: executing the same UPDATE RETURNING with all refreshes the cutoff", () => {
    const db = new Database(":memory:");
    try {
        seed(db);
        expect(db.prepare(UPDATE_RETURNING).all(SESSION)).toEqual([{ tag_number: 6 }]);
        expectCommittedProjection(db);
    } finally {
        db.close();
    }
});

test("mixed tuple write: status plus identity assignments must refresh the reasoning cutoff", () => {
    const db = new Database(":memory:");
    try {
        seed(db);
        db.prepare(
            "UPDATE tags SET status = 'dropped', (tag_number, reasoning_token_count) = (6, 1000) WHERE session_id = ? AND message_id = 'old'",
        ).run(SESSION);
        expectCommittedProjection(db);
    } finally {
        db.close();
    }
});
test("mixed tuple write: scalar identity assignments refresh the reasoning cutoff", () => {
    const db = new Database(":memory:");
    try {
        seed(db);
        db.prepare(
            "UPDATE tags SET status = 'dropped', tag_number = 6, reasoning_token_count = 1000 WHERE session_id = ? AND message_id = 'old'",
        ).run(SESSION);
        expectCommittedProjection(db);
    } finally {
        db.close();
    }
});

test("external process writes: data_version refreshes owner maxima and reasoning estimates", async () => {
    const { dir, cleanup } = createTestTempDir("mc-stall-cache-review-");
    const path = join(dir, "context.db");
    const db = new Database(path);
    try {
        seed(db);
        // A raw connection in a child process cannot bump the parent's generation.
        const child = Bun.spawn(
            [
                process.execPath,
                "-e",
                `
            import { Database } from 'bun:sqlite';
            const db = new Database(process.argv[1]);
            db.prepare(${JSON.stringify(UPDATE_RETURNING)}).all(${JSON.stringify(SESSION)});
            db.close();
        `,
                path,
            ],
            { stdout: "pipe", stderr: "pipe" },
        );
        const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect({ code, errors }).toEqual({ code: 0, errors: "" });
        expectCommittedProjection(db);
    } finally {
        db.close();
        cleanup();
    }
});
