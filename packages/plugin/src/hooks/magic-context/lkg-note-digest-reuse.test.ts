/// <reference types="bun-types" />

import { describe, expect, it, spyOn } from "bun:test";
import { Hash } from "node:crypto";
import { captureSlot, lkgContentDigest, noteEntry, resetLkgSlotsForTest } from "./lkg-slot";
import type { MessageLike } from "./tag-messages";

function message(id: string, text: string): MessageLike {
    return {
        info: { id, role: "user" },
        parts: [{ type: "text", text }],
    } as MessageLike;
}

describe("LKG note digest reuse", () => {
    it("hashes only a changed entry on the next note of the same prefix", async () => {
        resetLkgSlotsForTest();
        const messages = Array.from({ length: 8 }, (_, index) =>
            message(`m-${index}`, `body ${index} ${"x".repeat(40)}`),
        );
        const anchor = messages.at(-1)!;
        captureSlot("session", {
            jsonPrefix: "[]",
            inputIdSeq: messages.map((item) => item.info.id as string),
            inputContentDigests: messages.map((item) => lkgContentDigest(item)!),
            lastInputMessageId: anchor.info.id as string,
            modelKey: null,
            providerKey: null,
            capturedAt: 1,
        });
        const update = spyOn(Hash.prototype, "update");
        try {
            const first = noteEntry("session", messages);
            expect(first?.entryContentDigests).toHaveLength(messages.length);
            const firstUpdates = update.mock.calls.length;
            expect(firstUpdates).toBeGreaterThan(0);
            const second = noteEntry("session", messages);
            expect(second?.entryContentDigests).toEqual(first?.entryContentDigests);
            expect(update.mock.calls.length).toBe(firstUpdates);

            const changed = messages.map((item, index) =>
                index === 0 ? message("m-0", "edited") : item,
            );
            const third = noteEntry("session", changed);
            expect(update.mock.calls.length).toBeGreaterThan(firstUpdates);
            expect(third?.entryContentDigests[0]).toBe(lkgContentDigest(changed[0]!)!);
            expect(third?.entryContentDigests.slice(1)).toEqual(
                first?.entryContentDigests.slice(1),
            );
        } finally {
            update.mockRestore();
            resetLkgSlotsForTest();
        }
    });
});
