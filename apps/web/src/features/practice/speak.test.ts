// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { speak } from "./speak";
import type { SpeechFailure } from "./speak";

class Utterance extends EventTarget {
  lang = "";
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
}

const voice = {
  cancel: vi.fn<() => void>(),
  getVoices: () => [],
  speak: vi.fn<(utterance: Utterance) => void>(),
};

const fail = (error: string) => {
  const utterance = voice.speak.mock.calls[0]?.[0];
  if (!utterance) {
    throw new Error("No pronunciation was requested");
  }
  utterance.dispatchEvent(Object.assign(new Event("error"), { error }));
};

describe("browser pronunciation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("speechSynthesis", voice);
    vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["interrupted", "canceled"])(
    "does not report %s speech as unavailable",
    (reason) => {
      const unavailable = vi.fn<(failure: SpeechFailure) => void>();
      speak("être", unavailable);
      fail(reason);
      expect(unavailable).not.toHaveBeenCalled();
    }
  );

  it.each(["not-allowed", "synthesis-failed"])(
    "still reports a genuine %s failure",
    (reason) => {
      const unavailable = vi.fn<(failure: SpeechFailure) => void>();
      speak("être", unavailable);
      fail(reason);
      expect(unavailable).toHaveBeenCalledExactlyOnceWith({
        kind: "failed",
        reason,
      });
    }
  );
});
