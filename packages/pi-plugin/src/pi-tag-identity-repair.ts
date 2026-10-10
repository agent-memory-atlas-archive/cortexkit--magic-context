import {
	decodePiContentDecision,
	encodePiContentDecision,
	freezePiContentDecision,
	getPiContentDecisions,
} from "@magic-context/core/features/magic-context/pi-content-decisions";
import type { Database } from "@magic-context/core/shared/sqlite";

export const PI_TAG_IDENTITY_REPAIR_ONCE_GUARD = "pi-tag-identity-repair-once";
export const PI_TAG_IDENTITY_REPAIR_REASON = "tag_identity_repair";
export interface PiIdentityRebuild {
	key: string;
	kept: number;
	removed: number[];
	kind: "tool" | "message";
}

/**
 * Outcome of asking for the one unproven repair an identity may receive.
 * - `claimed`: this identity had no repair yet; the caller may keep the newest
 *   number and declare one `tag_identity_repair` rebuild.
 * - `recurring`: the identity was already repaired once (under `key` or one of
 *   `legacyKeys`). The caller must not repair it again and must not refuse
 *   the turn either: it leaves the rows unmerged and serves the identity the
 *   way tagging would without any repair.
 * - `unpersisted`: the guard could not be written (for example a full decision
 *   ledger). Without a durable guard a repair could repeat on every pass, so
 *   the caller treats it like `recurring`.
 */
export type PiIdentityRepairClaim = "claimed" | "recurring" | "unpersisted";

/** Caller holds the duplicate-fold writer transaction; persist that this identity has been repaired. */
export function claimPiIdentityRepair(
	db: Database,
	sessionId: string,
	key: string,
	legacyKeys: readonly string[] = [],
): PiIdentityRepairClaim {
	const decisions = getPiContentDecisions(db, sessionId);
	if (
		[key, ...legacyKeys].some((candidate) =>
			decisions.has(
				encodePiContentDecision("tag-identity-repair-once", candidate),
			),
		)
	)
		return "recurring";
	return freezePiContentDecision(db, sessionId, "tag-identity-repair-once", key)
		? "claimed"
		: "unpersisted";
}

/**
 * Record, once per identity, that a duplicate came back after its repair and
 * was served without merging. Returns true only when this call wrote the
 * record, so the caller logs the event once. Failing to write it (a full
 * ledger) is not a reason to refuse the turn; the caller still logs.
 */
export function recordPiIdentityRecurrence(
	db: Database,
	sessionId: string,
	key: string,
): boolean {
	const entry = encodePiContentDecision("tag-identity-recurring", key);
	if (getPiContentDecisions(db, sessionId).has(entry)) return false;
	freezePiContentDecision(db, sessionId, "tag-identity-recurring", key);
	return true;
}

export function readPiIdentityRecurrences(
	db: Database,
	sessionId: string,
): string[] {
	return [...getPiContentDecisions(db, sessionId)].flatMap((entry) => {
		const decoded = decodePiContentDecision(entry);
		return decoded?.[0] === "tag-identity-recurring" ? [decoded[1]] : [];
	});
}

/** Returns false when the rebuild could not be recorded; the caller then skips the repair. */
export function queuePiIdentityRebuild(
	db: Database,
	sessionId: string,
	repair: PiIdentityRebuild,
): boolean {
	return freezePiContentDecision(
		db,
		sessionId,
		"tag-identity-repair-pending",
		JSON.stringify(repair),
	);
}

export function readPiIdentityRebuilds(
	db: Database,
	sessionId: string,
): PiIdentityRebuild[] {
	const repairs = [...getPiContentDecisions(db, sessionId)].flatMap((entry) => {
		const decoded = decodePiContentDecision(entry);
		if (decoded?.[0] !== "tag-identity-repair-pending") return [];
		// A damaged record cannot name a number to protect. Ignoring it costs at
		// most the protection of one already-folded survivor for one pass; it
		// must not refuse the session's turns.
		let repair: PiIdentityRebuild;
		try {
			repair = JSON.parse(decoded[1]) as PiIdentityRebuild;
		} catch {
			return [];
		}
		if (
			typeof repair?.key !== "string" ||
			!Number.isSafeInteger(repair.kept) ||
			!Array.isArray(repair.removed) ||
			!repair.removed.every(Number.isSafeInteger) ||
			!["tool", "message"].includes(repair.kind)
		)
			return [];
		return [repair];
	});
	const byKey = new Map<string, PiIdentityRebuild>();
	for (const repair of repairs) {
		const previous = byKey.get(repair.key);
		byKey.set(repair.key, {
			...repair,
			removed: [...new Set([...(previous?.removed ?? []), ...repair.removed])],
		});
	}
	return [...byKey.values()];
}

export function acknowledgePiIdentityRebuilds(
	db: Database,
	sessionId: string,
): void {
	db.transaction(() => {
		const row = db
			.prepare(
				"SELECT merged_reasoning_stripped_ids AS entries FROM session_meta WHERE session_id = ?",
			)
			.get(sessionId) as { entries: string | null };
		const entries = row.entries ? (JSON.parse(row.entries) as string[]) : [];
		db.prepare(
			"UPDATE session_meta SET merged_reasoning_stripped_ids = ? WHERE session_id = ?",
		).run(
			JSON.stringify(
				entries.filter(
					(entry) =>
						decodePiContentDecision(entry)?.[0] !==
						"tag-identity-repair-pending",
				),
			),
			sessionId,
		);
	}).immediate();
}
