import type { Database } from "../../shared/sqlite";

/**
 * Per-session revision of the `tags` columns that identify a tag or carry its
 * reasoning estimate: `id`, `session_id`, `message_id`, `tag_number`, `type`,
 * `tool_owner_message_id` and `reasoning_token_count`.
 *
 * Caches built from those columns (the tag owner summary in storage-tags.ts)
 * can then tell, after another connection's commit, whether that commit
 * rewrote any of them for a session, without rereading the session's tags.
 * Status, drop-mode, size and token-count writes leave it alone.
 *
 * It lives in `schema_migrations_meta`, the key/value table that already holds
 * per-session `retrospective_activity:<session>` rows, so no schema change is
 * needed. The value only ever grows. Deletes are not counted: they change the
 * session's tag count, which the cache checks separately.
 */
export const TAG_IDENTITY_REVISION_PREFIX = "tag_identity_revision:";

export function tagIdentityRevisionKey(sessionId: string): string {
    return `${TAG_IDENTITY_REVISION_PREFIX}${sessionId}`;
}

const BUMP = (session: string) => `INSERT INTO schema_migrations_meta (key, value)
        VALUES ('${TAG_IDENTITY_REVISION_PREFIX}' || ${session}, '1')
        ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`;

/**
 * A TEMP trigger exists only on the connection that creates it and is not part
 * of the stored schema, so every Magic Context connection that can write tags
 * installs it when it opens (from `initializeDatabase`). It runs inside the
 * writing statement, so the bump commits or rolls back with the write itself.
 * It counts UPDATEs that assign any of the columns listed above, including the
 * update half of an upsert; inserts and deletes are not counted (they change
 * the session's tag count instead). Writes from connections that never ran
 * `initializeDatabase` (another tool editing the file directly) are not counted.
 */
const TRIGGER_SQL = `CREATE TEMP TRIGGER IF NOT EXISTS mc_tag_identity_revision_au
    AFTER UPDATE OF id, session_id, message_id, tag_number, type, tool_owner_message_id, reasoning_token_count
    ON main.tags
    BEGIN
        ${BUMP("OLD.session_id")};
        INSERT INTO schema_migrations_meta (key, value)
            SELECT '${TAG_IDENTITY_REVISION_PREFIX}' || NEW.session_id, '1'
            WHERE NEW.session_id IS NOT OLD.session_id
            ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT);
    END`;

export function installTagIdentityRevisionTrigger(db: Database): void {
    db.exec(TRIGGER_SQL);
}

/**
 * Drop the revision rows of sessions that no longer have any tags. A row is
 * kept while tags of the session remain (for example another harness's rows
 * after a harness-scoped cleanup): a tag summary that cached the old value
 * would otherwise read the restarted count as unchanged. Once no tags remain,
 * dropping it is harmless: a summary that cached any tag of the session sees
 * the session's tag count change and rebuilds, and rows added later are read
 * as new rows with their current values.
 */
export function deleteTagIdentityRevisions(db: Database, sessionIds: readonly string[]): void {
    const statement = db.prepare(
        "DELETE FROM schema_migrations_meta WHERE key = ? AND NOT EXISTS (SELECT 1 FROM tags WHERE session_id = ?)",
    );
    for (const sessionId of sessionIds) statement.run(tagIdentityRevisionKey(sessionId), sessionId);
}
