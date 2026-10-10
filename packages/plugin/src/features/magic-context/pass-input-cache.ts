import type { Database } from "../../shared/sqlite";

/**
 * Connection-local reuse for reads a transform pass repeats. The stamp is the
 * same pair search already uses: this connection's writes move `total_changes`,
 * and another process's commit moves `data_version`. A caller that passes a
 * revision sees a miss when that revision changes even if no SQL write did.
 */
export function readThroughPassCache<T>(
    db: Database,
    key: string,
    revision: string,
    read: () => T,
): T {
    const stamp = passCacheStamp(db);
    const caches = passCaches.get(db) ?? new Map<string, PassCacheEntry<unknown>>();
    if (!passCaches.has(db)) passCaches.set(db, caches);
    const cacheKey = `${key}\0${revision}`;
    const cached = caches.get(cacheKey);
    if (stamp && cached && cached.version === stamp.version && cached.changes === stamp.changes) {
        return copyPassCacheValue(cached.value) as T;
    }
    const value = read();
    if (stamp) {
        caches.set(cacheKey, {
            version: stamp.version,
            changes: stamp.changes,
            value: copyPassCacheValue(value),
        });
        if (caches.size > 64) {
            const oldest = caches.keys().next().value;
            if (oldest !== undefined) caches.delete(oldest);
        }
    }
    return value;
}

function copyPassCacheValue<T>(value: T): T {
    if (value instanceof Map) return new Map(value) as T;
    if (value instanceof Set) return new Set(value) as T;
    if (Array.isArray(value)) return [...value] as T;
    return value;
}

interface PassCacheEntry<T> {
    version: number;
    changes: number;
    value: T;
}

const passCaches = new WeakMap<Database, Map<string, PassCacheEntry<unknown>>>();

function passCacheStamp(db: Database): { version: number; changes: number } | null {
    try {
        return db
            .prepare(
                "SELECT total_changes() AS changes, data_version AS version FROM pragma_data_version",
            )
            .get() as { version: number; changes: number };
    } catch {
        return null;
    }
}
