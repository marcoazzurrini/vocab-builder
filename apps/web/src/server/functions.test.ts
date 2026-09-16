import type { UserRepository } from "@vocab/database";
import { DEFAULT_SETTINGS } from "@vocab/spaced-repetition";
import { describe, expect, it, vi } from "vitest";

import { readPractice } from "./functions";

describe("practice bootstrap", () => {
  it("resolves one authenticated repository and uses the settings language for the snapshot", async () => {
    const settings = { ...DEFAULT_SETTINGS, lang: "de" };
    const snapshot = { cards: [], guesses: [], words: [] };
    const progress = {
      settings: vi.fn<UserRepository["settings"]>().mockResolvedValue(settings),
      snapshot: vi.fn<UserRepository["snapshot"]>().mockResolvedValue(snapshot),
    };
    const resolve = vi
      .fn<(userId: string) => Promise<typeof progress>>()
      .mockResolvedValue(progress);
    await expect(readPractice("u1", resolve)).resolves.toStrictEqual({
      settings,
      snapshot,
    });
    expect(resolve).toHaveBeenCalledExactlyOnceWith("u1");
    expect(progress.settings).toHaveBeenCalledOnce();
    expect(progress.snapshot).toHaveBeenCalledExactlyOnceWith("de");
  });

  it("propagates account mismatch without starting any reads", async () => {
    const progress = {
      settings: vi.fn<UserRepository["settings"]>(),
      snapshot: vi.fn<UserRepository["snapshot"]>(),
    };
    const resolve = vi
      .fn<(userId: string) => Promise<typeof progress>>()
      .mockRejectedValue(new Error("The signed-in account changed."));
    await expect(readPractice("u1", resolve)).rejects.toThrow(
      "The signed-in account changed."
    );
    expect(resolve).toHaveBeenCalledExactlyOnceWith("u1");
    expect(progress.settings).not.toHaveBeenCalled();
    expect(progress.snapshot).not.toHaveBeenCalled();
  });

  it("does not read a snapshot when settings fail", async () => {
    const progress = {
      settings: vi
        .fn<UserRepository["settings"]>()
        .mockRejectedValue(new Error("Could not read settings.")),
      snapshot: vi.fn<UserRepository["snapshot"]>(),
    };
    await expect(
      readPractice("u1", () => Promise.resolve(progress))
    ).rejects.toThrow("Could not read settings.");
    expect(progress.snapshot).not.toHaveBeenCalled();
  });
});
