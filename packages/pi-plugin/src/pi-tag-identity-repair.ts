import {
	decodePiContentDecision,
	encodePiContentDecision,
	freezePiContentDecision,
	getPiContentDecisions,
} from "@magic-context/core/features/magic-context/pi-content-decisions";
import { PiTagIdentityConflictError } from "@magic-context/core/features/magic-context/storage-tags";
import type { Database } from "@magic-context/core/shared/sqlite";

export const PI_TAG_IDENTITY_REPAIR_ONCE_GUARD = "pi-tag-identity-repair-once";
export const PI_TAG_IDENTITY_REPAIR_REASON = "tag_identity_repair";
export interface PiIdentityRebuild {
	key: string;
	kept: number;
	removed: number[];
	kind: "tool" | "message";
}

/** Caller holds the duplicate-fold writer transaction; persist that this identity has already been repaired. */
export function claimPiIdentityRepair(
	db: Database,
	sessionId: string,
	key: string,
	kind: "tool" | "message",
): void {
	if (
		getPiContentDecisions(db, sessionId).has(
			encodePiContentDecision("tag-identity-repair-once", key),
		)
	)
		throw new PiTagIdentityConflictError(
			`${PI_TAG_IDENTITY_REPAIR_ONCE_GUARD} refused a recurrence on the same identity`,
			kind,
		);
	if (!freezePiContentDecision(db, sessionId, "tag-identity-repair-once", key))
		throw new PiTagIdentityConflictError(
			"identity repair guard could not be persisted",
			kind,
		);
}

export function queuePiIdentityRebuild(
	db: Database,
	sessionId: string,
	repair: PiIdentityRebuild,
): void {
	if (
		!freezePiContentDecision(
			db,
			sessionId,
			"tag-identity-repair-pending",
			JSON.stringify(repair),
		)
	)
		throw new PiTagIdentityConflictError(
			"identity rebuild could not be persisted",
			repair.kind,
		);
}

export function readPiIdentityRebuilds(
	db: Database,
	sessionId: string,
): PiIdentityRebuild[] {
	const repairs = [...getPiContentDecisions(db, sessionId)].flatMap((entry) => {
		const decoded = decodePiContentDecision(entry);
		if (decoded?.[0] !== "tag-identity-repair-pending") return [];
		let repair: PiIdentityRebuild;
		try {
			repair = JSON.parse(decoded[1]) as PiIdentityRebuild;
		} catch {
			throw new PiTagIdentityConflictError("invalid pending identity rebuild");
		}
		if (
			typeof repair.key !== "string" ||
			!Number.isSafeInteger(repair.kept) ||
			!Array.isArray(repair.removed) ||
			!repair.removed.every(Number.isSafeInteger) ||
			!["tool", "message"].includes(repair.kind)
		)
			throw new PiTagIdentityConflictError("invalid pending identity rebuild");
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
