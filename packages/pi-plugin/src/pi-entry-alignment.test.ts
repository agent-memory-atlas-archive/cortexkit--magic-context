import { describe, expect, it, spyOn } from "bun:test";
import {
	buildSessionContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as logger from "@magic-context/core/shared/logger";
import { __test, clearContextHandlerSession } from "./context-handler";

// The positional entry-id lane trusts that Pi built the event from the branch
// projection. An extension earlier in Pi's context chain may replace or
// reorder messages while keeping the count; each position is therefore
// checked against its projected entry before the lane is used.

const ctx = {} as ExtensionContext;

function entry(
	id: string,
	parentId: string | null,
	message: Record<string, unknown>,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(message.timestamp as number).toISOString(),
		message,
	} as unknown as SessionEntry;
}

function buildEntries(sameTimestampPair = false): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;
	const push = (id: string, message: Record<string, unknown>) => {
		entries.push(entry(id, parentId, message));
		parentId = id;
	};
	push("system-entry", {
		role: "system",
		content: "You are a coding agent.",
		timestamp: 1_000,
	});
	for (let index = 0; index < 10; index += 1) {
		// Entries 4 and 5 can share a millisecond, as two messages appended in
		// one tick do; then only their content tells them apart.
		const timestamp =
			sameTimestampPair && index === 5 ? 2_000 + 4 : 2_000 + index;
		push(`entry-${index}`, {
			role:
				index % 2 === 0 || (sameTimestampPair && index === 5)
					? "user"
					: "assistant",
			content:
				index % 2 === 0 || (sameTimestampPair && index === 5)
					? `Message ${index}`
					: [{ type: "text", text: `Answer ${index}` }],
			timestamp,
		});
	}
	return entries;
}

/** The array Pi 0.87 hands `context` handlers: a clone without system messages. */
function eventMessages(entries: SessionEntry[]): unknown[] {
	const byId = new Map(entries.map((row) => [row.id, row]));
	return structuredClone(
		buildSessionContext(entries, entries.at(-1)?.id ?? null, byId).messages,
	).filter((message) => (message as { role?: unknown }).role !== "system");
}

const expectedIds = Array.from({ length: 10 }, (_, index) => `entry-${index}`);

function resolve(
	sessionId: string,
	entries: SessionEntry[],
	messages: unknown[],
) {
	return __test.resolvePiEventEntryIds(
		ctx,
		messages as Parameters<typeof __test.resolvePiEventEntryIds>[1],
		sessionId,
		entries,
	);
}

describe("Pi positional entry-id alignment", () => {
	it("uses the positional lane without hashing when every position matches", () => {
		const entries = buildEntries();
		resolve("alignment-clean", entries, eventMessages(entries));
		const before = __test.readPiEntryFingerprintCount();
		const ids = resolve("alignment-clean", entries, eventMessages(entries));
		expect(__test.readPiEntryFingerprintCount() - before).toBe(0);
		expect([...(ids ?? [])]).toEqual(expectedIds);
		clearContextHandlerSession("alignment-clean");
	});

	it("falls back to content matching when an earlier extension swaps two messages", () => {
		const entries = buildEntries();
		const messages = eventMessages(entries);
		[messages[3], messages[6]] = [messages[6], messages[3]];
		const log = spyOn(logger, "sessionLog");
		try {
			const ids = resolve("alignment-swap", entries, messages);
			const swapped = [...expectedIds];
			[swapped[3], swapped[6]] = [swapped[6], swapped[3]];
			expect([...(ids ?? [])]).toEqual(swapped);
			resolve("alignment-swap", entries, messages);
			// One line per session, naming the first position that did not match.
			expect(
				log.mock.calls
					.map((call) => call[1])
					.filter((line) => line.startsWith("pi entry alignment:")),
			).toEqual([
				"pi entry alignment: message 3 of 10 does not match its projected entry; resolving ids by content fingerprint (logged once per session)",
			]);
		} finally {
			log.mockRestore();
			clearContextHandlerSession("alignment-swap");
		}
	});

	it("falls back to content matching when an earlier extension replaces a message", () => {
		const entries = buildEntries();
		const messages = eventMessages(entries);
		messages[4] = {
			role: "user",
			content: "Injected by another extension",
			timestamp: 9_999,
		};
		const ids = resolve("alignment-replace", entries, messages);
		const replaced: (string | undefined)[] = [...expectedIds];
		replaced[4] = undefined;
		expect([...(ids ?? [])]).toEqual(replaced);
		clearContextHandlerSession("alignment-replace");
	});

	it("checks content where two entries share every header field", () => {
		const entries = buildEntries(true);
		const messages = eventMessages(entries);
		[messages[4], messages[5]] = [messages[5], messages[4]];
		const ids = resolve("alignment-same-header", entries, messages);
		const swapped = [...expectedIds];
		[swapped[4], swapped[5]] = [swapped[5], swapped[4]];
		expect([...(ids ?? [])]).toEqual(swapped);
		clearContextHandlerSession("alignment-same-header");
	});
});
