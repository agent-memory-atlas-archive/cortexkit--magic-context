import { createHash } from "node:crypto";
import { getSlot } from "@magic-context/core/hooks/magic-context/lkg-slot";
import {
	getPiLastServedArray,
	getPiLastServedDigest,
} from "./served-array-ledger";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function contentParts(
	message: Record<string, unknown>,
): Record<string, unknown>[] {
	return Array.isArray(message.content)
		? message.content.flatMap((part) => {
				const p = record(part);
				return p ? [p] : [];
			})
		: [];
}

/** Prose edits do not change a tool call's owner; repeated call ids alone are not unique. */
export function piAssistantToolIdentity(message: unknown): string | undefined {
	const m = record(message);
	if (
		m?.role !== "assistant" ||
		typeof m.timestamp !== "number" ||
		!Number.isFinite(m.timestamp)
	)
		return;
	const ids = contentParts(m)
		.filter((p) => p.type === "toolCall")
		.map((p) => p.id);
	if (!ids.length || ids.some((id) => typeof id !== "string" || !id)) return;
	return JSON.stringify([m.timestamp, ids]);
}

/**
 * A saved last-known-good (LKG) array may have been captured but never returned
 * to Pi. Its digest must match the last returned array before its bytes can
 * authorize removing a duplicate tag. Marker text quoted outside this call's
 * structured tool result can veto a deletion, but cannot identify the kept tag.
 */
export function piCachedToolSurvivor(
	sessionId: string,
	callId: string,
	timestamp: number,
	rows: readonly { tagNumber: number; status: string }[],
): number | undefined {
	const cached = readPiServedCachedArray(sessionId);
	if (!cached) return;
	const { jsonPrefix, messages } = cached;
	const owners = messages.filter(
		(m) =>
			m.role === "assistant" &&
			contentParts(m).some((p) => p.type === "toolCall" && p.id === callId),
	);
	const owner = owners[0];
	if (
		!owner ||
		owners.length !== 1 ||
		owner.timestamp !== timestamp ||
		contentParts(owner).filter((p) => p.type === "toolCall" && p.id === callId)
			.length !== 1
	)
		return;
	const present = rows.filter((row) =>
		jsonPrefix.includes(`§${row.tagNumber}§`),
	);
	const winner = present[0];
	if (present.length !== 1 || !winner) return;
	const { tagNumber: number, status } = winner;
	if (status !== "active" && status !== "dropped") return;
	const results = messages.filter(
		(m) => m.role === "toolResult" && m.toolCallId === callId,
	);
	if (
		!results.some((m) =>
			contentParts(m).some(
				(p) =>
					p.type === "text" &&
					(status === "dropped"
						? p.text === `[dropped §${number}§]`
						: typeof p.text === "string" && p.text.startsWith(`§${number}§ `)),
			),
		)
	)
		return;
	return number;
}

export function readPiServedCachedArray(
	sessionId: string,
): { jsonPrefix: string; messages: Record<string, unknown>[] } | undefined {
	// A reshaped input can invalidate last-known-good (LKG) replay without
	// discarding the exact array returned to Pi. After process restart, accept a
	// saved LKG only when its digest matches the last returned-array record.
	const memory = getPiLastServedArray(sessionId);
	const slot = memory === undefined ? getSlot(sessionId) : undefined;
	const jsonPrefix = memory ?? slot?.jsonPrefix;
	if (
		jsonPrefix === undefined ||
		createHash("sha256").update(jsonPrefix).digest("hex") !==
			getPiLastServedDigest(sessionId)
	)
		return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonPrefix);
	} catch {
		return;
	}
	if (!Array.isArray(parsed)) return;
	const messages = parsed.flatMap((m) => {
		const r = record(m);
		return r ? [r] : [];
	});
	return { jsonPrefix, messages };
}
