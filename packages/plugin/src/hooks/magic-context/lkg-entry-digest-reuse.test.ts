/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
    captureSlot,
    getLkgDigestsComputedForTest,
    type LkgContentField,
    lkgContentDigest,
    lkgContentDigestFromFields,
    lkgContentFields,
    noteEntry,
    resetLkgSlotsForTest,
} from "./lkg-slot";
import type { MessageLike } from "./tag-messages";

function message(index: number, text = `message ${index}`): MessageLike {
    return {
        info: {
            id: `msg_${String(index).padStart(7, "0")}`,
            role: index % 2 ? "assistant" : "user",
        },
        parts: [{ type: "text", text }],
    } as unknown as MessageLike;
}

function anchorAt(sessionId: string, messages: readonly MessageLike[], index: number): void {
    const id = (messages[index]?.info as { id: string }).id;
    expect(
        captureSlot(sessionId, {
            jsonPrefix: "[]",
            inputIdSeq: [],
            inputContentDigests: [],
            lastInputMessageId: id,
            modelKey: null,
            providerKey: null,
            capturedAt: 1,
        }),
    ).toBe(true);
}

/** Hashes an ordinary pass needs after `appended` new messages joined the served prefix. */
function hashesForNextPass(sessionLength: number, appended: number): number {
    resetLkgSlotsForTest();
    // OpenCode rebuilds the message objects for every request, so each pass gets
    // fresh copies with the same content.
    const pass = (length: number) => Array.from({ length }, (_, index) => message(index));
    const first = pass(sessionLength);
    anchorAt("session", first, sessionLength - 1);
    expect(noteEntry("session", first)?.entryContentDigests).toHaveLength(sessionLength);

    const second = pass(sessionLength + appended);
    anchorAt("session", second, sessionLength + appended - 1);
    const before = getLkgDigestsComputedForTest();
    const note = noteEntry("session", second);
    const hashed = getLkgDigestsComputedForTest() - before;
    // Reused digests are the values a full recompute gives.
    expect(note?.entryContentDigests).toEqual(second.map((entry) => lkgContentDigest(entry)!));
    return hashed;
}

/** The digest as it was computed before: three hash updates per token. */
function frozenDigest(fields: readonly LkgContentField[]): string {
    const hash = createHash("sha256");
    for (const field of fields) {
        const value = typeof field === "symbol" ? (field.description ?? "") : String(field);
        hash.update(`${typeof field}:${value.length}:`)
            .update(value)
            .update("\0");
    }
    return hash.digest("base64url");
}

describe("LKG entry digests", () => {
    beforeEach(() => resetLkgSlotsForTest());

    it("hashes the joined token text to the same digest as per-token updates", () => {
        const values: unknown[] = [
            { info: { id: "m", role: "user" }, parts: [{ type: "text", text: "plain" }] },
            { text: "pair \ud83d\ude00 and lone \ud83d", tail: "\ude00 lone low", n: -0, f: 1.5 },
            { nested: [null, true, false, 0, "", [], {}], key: "a\u0000b", utf: "çé日本" },
            ["\ud800", "\udfff", "x\ud800", "\udc00x"],
        ];
        for (const value of values) {
            const fields = lkgContentFields(value)!;
            expect(lkgContentDigestFromFields(fields)).toBe(frozenDigest(fields));
        }
    });

    it("hashes only the messages added since the last pass, however long the prefix", () => {
        // 25,000 is past the shared digest memo's 20,000-entry bound, where every
        // message used to be evicted before the next pass reached it again.
        expect(hashesForNextPass(2_000, 3)).toBe(3);
        expect(hashesForNextPass(25_000, 3)).toBe(3);
    });

    it("hashes a changed message again even when its id is unchanged", () => {
        const first = [message(0), message(1), message(2)];
        anchorAt("edited", first, 2);
        noteEntry("edited", first);
        const second = [message(0), message(1, "edited text"), message(2)];
        const before = getLkgDigestsComputedForTest();
        const note = noteEntry("edited", second);
        expect(getLkgDigestsComputedForTest() - before).toBe(1);
        expect(note?.entryContentDigests).toEqual(second.map((entry) => lkgContentDigest(entry)!));
    });

    it("hashes again when only a value's type changes", () => {
        const typed = (value: unknown) =>
            ({
                info: { id: "typed", role: "user" },
                parts: [{ type: "text", n: value }],
            }) as unknown as MessageLike;
        anchorAt("typed", [typed(1)], 0);
        noteEntry("typed", [typed(1)]);
        for (const value of ["1", true, "true", 1]) {
            const before = getLkgDigestsComputedForTest();
            const note = noteEntry("typed", [typed(value)]);
            expect({ value, hashed: getLkgDigestsComputedForTest() - before }).toEqual({
                value,
                hashed: 1,
            });
            expect(note?.entryContentDigests).toEqual([lkgContentDigest(typed(value))!]);
        }
    });

    it("reuses digests when the head of the array is trimmed", () => {
        const first = Array.from({ length: 10 }, (_, index) => message(index));
        anchorAt("trimmed", first, 9);
        noteEntry("trimmed", first);
        const second = Array.from({ length: 8 }, (_, index) => message(index + 2));
        const before = getLkgDigestsComputedForTest();
        const note = noteEntry("trimmed", second);
        expect(getLkgDigestsComputedForTest() - before).toBe(0);
        expect(note?.entryContentDigests).toEqual(second.map((entry) => lkgContentDigest(entry)!));
    });
});
