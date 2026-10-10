/**
 * Before/after cost of the four serving-thread stalls on a synthetic OpenCode
 * session of about 150k messages. Every database lives under the throwaway root
 * named by COST_ROOT. This script never opens a path outside that root.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "../src/shared/sqlite";
import {
    readRawSessionMessageByIdFromDb,
    resetProvenRawSessionOrdinalsForTest,
} from "../src/hooks/magic-context/read-session-raw";
import { noteEntry, captureSlot, lkgContentDigest, resetLkgSlotsForTest } from "../src/hooks/magic-context/lkg-slot";
import { projectOpencodeReasoningBudgetCutoff } from "../src/hooks/magic-context/reasoning-budget";
import { initializeDatabase } from "../src/features/magic-context/storage-db";
import { insertTag } from "../src/features/magic-context/storage-tags";
import { ensureMessagesIndexed } from "../src/features/magic-context/message-index";
import { unifiedSearch } from "../src/features/magic-context/search";

const root = process.env.COST_ROOT;
if (!root) throw new Error("COST_ROOT is required");
mkdirSync(root, { recursive: true });
const size = Number(process.env.COST_SIZE ?? 150_000);
const opencode = new Database(join(root, "opencode.db"));
opencode.exec(`
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
const insert = opencode.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'session', ?, ?, ?)",
);
const insertPart = opencode.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, 'session', ?, ?, ?)",
);
console.log(`building ${size} messages`);
const started = performance.now();
opencode.transaction(() => {
    for (let index = 0; index < size; index += 1) {
        const id = `m-${String(index).padStart(7, "0")}`;
        const summary = index % 4096 === 0 && index > 0;
        insert.run(
            id,
            index,
            index,
            JSON.stringify({
                role: index % 2 === 0 ? "user" : "assistant",
                summary: summary ? true : undefined,
                finish: "stop",
                text: summary ? "compacted" : `body ${index % 1000}`,
            }),
        );
        if (index % 50 === 0) {
            insertPart.run(`p-${index}`, id, index, index, JSON.stringify({ type: "text", text: "part" }));
        }
    }
})();
console.log(`built in ${Math.round(performance.now() - started)}ms`);

function time(label: string, run: () => void): void {
    const mark = performance.now();
    run();
    console.log(`${label} ${Math.round(performance.now() - mark)}ms`);
}

async function timeAsync(label: string, run: () => Promise<void>): Promise<void> {
    const mark = performance.now();
    await run();
    console.log(`${label} ${Math.round(performance.now() - mark)}ms`);
}

resetProvenRawSessionOrdinalsForTest();
const target = `m-${String(size - 1).padStart(7, "0")}`;
time("ordinal cold", () => {
    const message = readRawSessionMessageByIdFromDb(opencode, "session", target);
    if (!message) throw new Error("cold ordinal missing");
    console.log(`  ordinal=${message.ordinal}`);
});
time("ordinal warm", () => {
    const appended = `m-${String(size).padStart(7, "0")}`;
    insert.run(appended, size, size, JSON.stringify({ role: "assistant", finish: "stop" }));
    const message = readRawSessionMessageByIdFromDb(opencode, "session", appended);
    if (!message) throw new Error("warm ordinal missing");
    console.log(`  ordinal=${message.ordinal}`);
});

const context = new Database(join(root, "context.db"));
initializeDatabase(context);
const indexed = Array.from({ length: Math.min(size, 2_000) }, (_, index) => ({
    ordinal: index + 1,
    id: `m-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    createdAt: index,
    parts: [{ type: "text", text: index % 20 === 0 ? "CommonTerm marker" : `body ${index}` }],
}));
ensureMessagesIndexed(context, "session", () => indexed);
await timeAsync("search first", async () => {
    await unifiedSearch(context, "session", "/repo", "CommonTerm", {
        memoryEnabled: false,
        embeddingEnabled: false,
        sources: ["message"],
        explicitSearch: true,
        readMessages: () => indexed,
    });
});
await timeAsync("search second", async () => {
    await unifiedSearch(context, "session", "/repo", "CommonTerm", {
        memoryEnabled: false,
        embeddingEnabled: false,
        sources: ["message"],
        explicitSearch: true,
        readMessages: () => indexed,
    });
});

context.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("session");
for (let index = 0; index < 200; index += 1) {
    insertTag(context, "session", `m-${index}`, "message", 10, index + 1, 0, null, 0, null, null, {
        tokenCount: 10,
        inputTokenCount: 0,
        reasoningTokenCount: 10,
    });
}
const reasoning = indexed.slice(0, 200).map((message) => ({
    info: { id: message.id, role: "assistant", tokens: { reasoning: 10 } },
    parts: [{ type: "reasoning", thinking: "thinking" }],
}));
time("reasoning first", () => {
    projectOpencodeReasoningBudgetCutoff(context, "session", reasoning as never, 1000, 0, 1);
});
time("reasoning second", () => {
    projectOpencodeReasoningBudgetCutoff(context, "session", reasoning as never, 1000, 0, 1);
});

resetLkgSlotsForTest();
const wire = indexed.slice(0, 200).map((message) => ({
    info: { id: message.id, role: message.role },
    parts: message.parts,
}));
captureSlot("session", {
    jsonPrefix: "[]",
    inputIdSeq: wire.map((message) => message.info.id),
    inputContentDigests: wire.map(() => "digest"),
    lastInputMessageId: wire.at(-1)!.info.id,
    modelKey: null,
    providerKey: null,
    capturedAt: 1,
});
void lkgContentDigest;
time("lkg first", () => {
    noteEntry("session", wire as never);
});
time("lkg second", () => {
    noteEntry("session", wire as never);
});
opencode.close();
context.close();
console.log("done");
