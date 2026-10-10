/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import {
    captureSlot,
    getLkgDigestsComputedForTest,
    lkgContentDigest,
    noteEntry,
    resetLkgSlotsForTest,
} from "./lkg-slot";
import type { MessageLike } from "./tag-messages";

function message(index: number, text = `message ${index}`): MessageLike {
    return {
        info: { id: `msg_${String(index).padStart(7, "0")}`, role: index % 2 ? "assistant" : "user" },
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

describe("LKG entry digests", () => {
    beforeEach(() => resetLkgSlotsForTest());

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
