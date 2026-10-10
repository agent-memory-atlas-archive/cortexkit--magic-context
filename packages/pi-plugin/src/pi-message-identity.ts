import { createHash } from "node:crypto";
import { stripTagPrefix } from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import { stableStringify } from "@magic-context/core/shared/stable-json";
import { readPiServedCachedArray } from "./pi-tool-identity";

export function piMessageEntryFingerprint(message: unknown): string | null {
	if (!message || typeof message !== "object") return null;
	const m = message as Record<string, unknown>;
	if (typeof m.role !== "string") return null;
	const contentHash = createHash("sha256")
		.update(stableStringify(m.content))
		.digest("hex");
	return JSON.stringify([
		typeof m.responseId === "string" ? m.responseId : null,
		typeof m.timestamp === "number" || typeof m.timestamp === "string"
			? m.timestamp
			: null,
		m.role,
		typeof m.toolCallId === "string" ? m.toolCallId : null,
		contentHash,
	]);
}

/** Remove leading §N§ decorations for raw-message hashing; quoted §N§ elsewhere is not owner proof. */
function withoutPrefixes(
	message: Record<string, unknown>,
): Record<string, unknown> {
	const content =
		typeof message.content === "string"
			? stripTagPrefix(message.content)
			: Array.isArray(message.content)
				? message.content.map((part) => {
						if (!part || typeof part !== "object") return part;
						const p = part as Record<string, unknown>;
						return p.type === "text" && typeof p.text === "string"
							? { ...p, text: stripTagPrefix(p.text) }
							: p;
					})
				: message.content;
	return { ...message, content };
}

export function piCachedMessageSurvivor(
	sessionId: string,
	fingerprint: string,
	ordinal: number,
	rows: readonly { tagNumber: number; status: string }[],
): number | undefined {
	const cached = readPiServedCachedArray(sessionId);
	if (!cached) return;
	const present = rows.filter((row) =>
		cached.jsonPrefix.includes(`§${row.tagNumber}§`),
	);
	const winner = present[0];
	if (present.length !== 1 || !winner || winner.status !== "active") return;
	// Compare the full content, role and timestamp, not just one equal text
	// block: different messages can legitimately contain the same prose.
	const matching = cached.messages.filter(
		(message) =>
			piMessageEntryFingerprint(withoutPrefixes(message)) === fingerprint,
	);
	const message = matching[0];
	if (matching.length !== 1 || !message) return;
	const texts =
		typeof message.content === "string"
			? [message.content]
			: Array.isArray(message.content)
				? message.content.flatMap((part) => {
						if (!part || typeof part !== "object") return [];
						const p = part as Record<string, unknown>;
						return p.type === "text" && typeof p.text === "string"
							? [p.text]
							: [];
					})
				: [];
	return texts[ordinal]?.startsWith(`§${winner.tagNumber}§ `)
		? winner.tagNumber
		: undefined;
}
