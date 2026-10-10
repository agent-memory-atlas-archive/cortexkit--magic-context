import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerPiContextHandler } from "../../pi-plugin/src/context-handler";
import { runMigrations } from "../../plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { setHarness } from "../../plugin/src/shared/harness";
import { Database } from "../../plugin/src/shared/sqlite";

// issue-650-probe.ts launches this host bundle in Node with HOME, XDG directories
// and both database overrides under one fresh root, keeping real sessions untouched.
const root = process.env.HOME!;
const host = await import(pathToFileURL(process.env.ISSUE_650_HOST!).href);
const agentDir = join(root, ".pi/agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "anthropic-messages",
				baseUrl: process.env.ISSUE_650_MOCK,
				apiKey: "mock-key",
				models: [
					{
						id: "mock",
						name: "Mock",
						reasoning: false,
						input: ["text"],
						contextWindow: 200000,
						maxTokens: 4096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
);
setHarness("pi");
const db = new Database(
	join(process.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"),
);
initializeDatabase(db);
runMigrations(db);
let perturb = false;
const snapshots: unknown[] = [];
const extension = (pi: any) => {
	pi.on("context", (event: any) => {
		if (!perturb) return;
		// A legal context-only extension edit: insert framing and rewrite the
		// assistant's prose, but leave the actual call and its timestamp intact.
		const messages = structuredClone(event.messages);
		const assistant = messages.find(
			(m: any) =>
				m.role === "assistant" &&
				m.content.some((p: any) => p.type === "toolCall"),
		);
		if (assistant)
			assistant.content.unshift({ type: "text", text: "context-only framing" });
		messages.unshift(
			{ role: "user", content: "temporary framing", timestamp: 1 },
			{ role: "user", content: "more framing", timestamp: 2 },
		);
		return { messages };
	});
	registerPiContextHandler(pi, { db, protectedTags: 0 });
	pi.on("context", (event: any) => {
		snapshots.push(structuredClone(event.messages));
	});
};
const codemode = process.env.ISSUE_650_CODEMODE === "1";
const loader = new host.DefaultResourceLoader({
	cwd: root,
	agentDir,
	extensionFactories: [
		...(codemode ? [host.createCodemodeExtension({ mode: "on" })] : []),
		extension,
	],
});
await loader.reload();
const settingsManager = host.SettingsManager.create(root, agentDir);
settingsManager.applyOverrides({
	defaultProvider: "mock",
	defaultModel: "mock",
	compaction: { enabled: false },
	...(codemode ? { defaultTools: ["+codemode"] } : {}),
});
const manager = host.SessionManager.create(root, join(root, "sessions"));
const { session } = await host.createAgentSession({
	cwd: root,
	agentDir,
	resourceLoader: loader,
	settingsManager,
	sessionManager: manager,
});
await session.bindExtensions({});
console.log("READY", process.pid);
await new Promise<void>((resolve) =>
	process.stdin.once("data", () => resolve()),
);
process.stdin.pause();
try {
	await session.prompt("make one tool call");
	const initial = db.prepare("SELECT * FROM tags WHERE type = 'tool'").all();
	perturb = true;
	await session.prompt("continue with temporary framing");
	const perturbed = db.prepare("SELECT * FROM tags WHERE type = 'tool'").all();
	perturb = false;
	await session.prompt("continue normally");
	const final = db.prepare("SELECT * FROM tags WHERE type = 'tool'").all();
	writeFileSync(
		join(root, "result.json"),
		JSON.stringify(
			{ initial, perturbed, final, snapshots, entries: manager.getBranch() },
			null,
			2,
		),
	);
	console.log(JSON.stringify({ initial, perturbed, final }));
	if (initial.length !== 1 || perturbed.length !== 1 || final.length !== 1)
		throw new Error("issue 650: tool call acquired a second tag");
	if ((initial[0] as any).tag_number !== (final[0] as any).tag_number)
		throw new Error("issue 650: served number changed");
	const results = (snapshots as any[][]).flatMap((messages) =>
		messages.filter(
			(m) => m.role === "toolResult" && m.toolCallId === "call650",
		),
	);
	if (
		!results.length ||
		results.some((m) => JSON.stringify(m) !== JSON.stringify(results[0]))
	)
		throw new Error("issue 650: already-served tool bytes changed");
	if (results[0].isError) throw new Error("mock tool call did not succeed");
	console.log("PASS: 3 turns, one tool identity, identical tool-result bytes");
	console.log("AUDIT_COMPLETE");
	await new Promise<void>((resolve) => {
		process.stdin.once("data", () => resolve());
		process.stdin.resume();
	});
	process.stdin.destroy();
} finally {
	session.dispose();
	db.close();
}
