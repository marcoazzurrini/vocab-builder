// @vitest-environment jsdom
import type { I18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render as testingRender,
  renderHook as testingRenderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { activateLocale, createI18n } from "@vocab/i18n";
import type {
  ReviewSnapshot,
  AnswerCommand,
  Word,
} from "@vocab/spaced-repetition";
import { DEFAULT_SETTINGS } from "@vocab/spaced-repetition";
import { StrictMode } from "react";
import type { PropsWithChildren, ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "@/components/patterns/app-shell";

import { practiceKey, practiceOptions } from "./queries";
import { SessionScreen } from "./session-screen";
import * as speech from "./speak";
import { SyncConflict } from "./sync-conflict";
import { RetryableReadError } from "./transport";
import type { PracticeTransport } from "./transport";
import { usePracticeSession } from "./use-practice-session";

const loadSnapshot = vi.fn<(lang: string) => Promise<ReviewSnapshot>>();
const persistAnswer =
  vi.fn<(command: AnswerCommand, expectedUserId: string) => Promise<void>>();

const transport: PracticeTransport = {
  loadPractice: async () => ({
    settings: DEFAULT_SETTINGS,
    snapshot: await loadSnapshot(DEFAULT_SETTINGS.lang),
  }),
  persistAnswer,
};

let queryClient: QueryClient;
let i18n: I18n;
const QueryWrapper = ({ children }: PropsWithChildren) => (
  <I18nProvider i18n={i18n}>
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  </I18nProvider>
);
const render = (ui: ReactElement) =>
  testingRender(ui, { wrapper: QueryWrapper });
const renderHook = <Result,>(useTestHook: () => Result) =>
  testingRenderHook(useTestHook, { wrapper: QueryWrapper });

const CHIEN: Word = {
  freqRank: 1,
  gloss: "cane",
  hint: null,
  id: "w1",
  image: "🐶",
  kind: "word",
  text: "chien",
};

const ETRE: Word = {
  ...CHIEN,
  gloss: "essere in un luogo (infinito)",
  image: null,
  presentation: {
    context: "Per indicare dove si trova qualcuno o qualcosa.",
    example: { text: "être à la maison", translation: "essere a casa" },
    explanation:
      "Impara l'infinito être. Scrivi solo il verbo, non l'intero esempio.",
    grammar: "verbo · infinito",
    meaning: "essere",
  },
  text: "être",
};

const deck = (words: Word[] = [CHIEN]): ReviewSnapshot => ({
  cards: [],
  guesses: [],
  words,
});

const recallDeck = (words: Word[] = [CHIEN]): ReviewSnapshot => ({
  ...deck(words),
  teachings: words.map((word) => ({
    initialRecallAt: new Date(Date.now() - 60_000).toISOString(),
    reviewedAt: new Date(Date.now() - 120_000).toISOString(),
    wordId: word.id,
  })),
});

const deferred = <T,>() => {
  // SAFETY: The Promise executor runs synchronously and assigns release before this helper returns.
  let release!: (value: T) => void;
  // eslint-disable-next-line promise/avoid-new -- Tests must control completion order; ES2023 lacks Promise.withResolvers.
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
};

const becomeVisible = () => {
  act(() => document.dispatchEvent(new Event("visibilitychange")));
};

const startSession = async () => {
  fireEvent.click(
    await screen.findByRole("button", {
      name: /^(?:Start session|Inizia sessione)$/u,
    })
  );
};

const FINISHED = /^(?:Session finished|Sessione terminata)$/u;
const CONTINUE_PRACTICING = /^(?:Continue practicing|Continua a esercitarti)$/u;
const outboxKeys = () =>
  Object.keys(window.localStorage).filter((key) =>
    /^vocab-builder:answer:v[12]:/u.test(key)
  );

describe("the session screen", () => {
  beforeEach(async () => {
    i18n = await createI18n("it");
    queryClient = new QueryClient();
    loadSnapshot.mockReset().mockResolvedValue(deck());
    persistAnswer.mockReset().mockResolvedValue();
    window.localStorage.clear();
  });
  afterEach(() => {
    // Not automatic: Testing Library only registers its own cleanup when
    // vitest runs with `globals: true`, and this project does not.
    cleanup();
    queryClient.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("teaches a new word after starting without asking for a guess", async () => {
    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByText("cane");
    expect(screen.getByRole("heading", { name: "chien" })).toBeDefined();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(persistAnswer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continua" }));
    await waitFor(() => expect(persistAnswer).toHaveBeenCalledOnce());
    expect(persistAnswer.mock.calls[0]?.[0]).toStrictEqual({
      expectedReps: 0,
      id: expect.any(String),
      latencyMs: expect.any(Number),
      phase: "teach",
      reviewedAt: expect.any(String),
      wordId: "w1",
    });
  });

  it("offers Listen when the browser blocks autoplay instead of showing an error", async () => {
    const voice = vi
      .spyOn(speech, "speak")
      .mockReturnValue()
      .mockImplementationOnce((_text, unavailable) =>
        unavailable?.({ kind: "failed", reason: "not-allowed" })
      );
    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByRole("button", { name: "Ascolta" });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ascolta" }));
    expect(voice).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText("Seleziona Ascolta per sentire la pronuncia.")
    ).toBeNull();
  });

  it("shows the word, meaning, example, and teaching notes without extra interactions", async () => {
    loadSnapshot.mockResolvedValue(deck([ETRE]));
    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByRole("heading", { name: "être" });
    expect(screen.getByText("essere")).toBeDefined();
    expect(screen.getByText("verbo · infinito")).toBeDefined();
    expect(screen.getByText("être à la maison")).toBeDefined();
    expect(screen.getByText("essere a casa")).toBeDefined();
    expect({
      answerInput: screen.queryByRole("textbox"),
      legacyCue: screen.queryByText(ETRE.gloss),
      usageNotes: screen.queryByRole("button", { name: "Note d’uso" }),
    }).toStrictEqual({
      answerInput: null,
      legacyCue: null,
      usageNotes: null,
    });
  });

  it("keeps the word meaning clear during recall without revealing the French entry or example", async () => {
    loadSnapshot.mockResolvedValue(recallDeck([ETRE]));
    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByRole("textbox", {
      name: "scrivi la parola in francese",
    });
    expect(screen.getByRole("heading", { name: "essere" })).toBeDefined();
    expect(
      screen.getByText("Per indicare dove si trova qualcuno o qualcosa.")
    ).toBeDefined();
    expect([
      screen.queryByText("être"),
      screen.queryByText("être à la maison"),
      screen.queryByText(ETRE.presentation?.explanation ?? ""),
      screen.queryByText(ETRE.gloss),
    ]).toStrictEqual([null, null, null, null]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "être à la maison" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Normale" }));
    await screen.findByText("être");
    await waitFor(() => expect(persistAnswer).toHaveBeenCalledOnce());
    expect(persistAnswer.mock.calls[0]?.[0]).toMatchObject({
      phase: "recall",
      rating: 1,
      typed: "être à la maison",
    });
  });

  it("switches interface language without discarding the current answer or changing study content", async () => {
    loadSnapshot.mockResolvedValue(recallDeck());
    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByText("cane");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "chi" } });

    await act(() => activateLocale(i18n, "en"));

    expect(screen.getByRole("button", { name: "Good" })).toBeDefined();
    expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe("chi");
    expect(screen.getByText("cane")).toBeDefined();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not rebuild the session mid-card when the tab comes back", async () => {
    // Rebuilding here would throw away the prompt on screen.
    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByText("cane");

    becomeVisible();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps a finished block ended when the tab comes back on the same day", async () => {
    loadSnapshot.mockResolvedValue(deck([]));
    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByRole("heading", { name: FINISHED });

    becomeVisible();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: FINISHED })).toBeDefined();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("rebuilds when the tab comes back on a new day", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-10T23:50:00"));

    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByText("cane");

    // Left open across midnight: the rule would start serving tomorrow's
    // reviews while the allowance is still yesterday's.
    vi.setSystemTime(new Date("2026-08-11T07:30:00"));
    becomeVisible();

    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(3));
  });

  it("waits for writes in flight before rebuilding the deck", async () => {
    // A rebuild that reads the database past its own unfinished writes serves
    // the card just answered again. The deck must not be re-read until the
    // queue has drained.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-10T23:50:00"));

    const pending = deferred<null>();
    persistAnswer.mockImplementation(async () => {
      await pending.promise;
    });

    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByText("cane");
    // Teaching completion, whose write hangs.
    fireEvent.click(screen.getByText("Continua"));

    vi.setSystemTime(new Date("2026-08-11T07:30:00"));
    // A new day, so a rebuild is wanted — but not yet.
    becomeVisible();

    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(loadSnapshot).toHaveBeenCalledTimes(2);

    pending.resolve(null);
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(3));
  });

  it("keeps a finished block ended when a card becomes due until explicitly continued", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-10T09:00:00"));

    const learning = {
      difficulty: 5,
      due: new Date("2026-08-10T09:04:00"),
      elapsed_days: 0,
      lapses: 0,
      learning_steps: 0,
      reps: 1,
      scheduled_days: 0,
      stability: 1,
      state: 1,
    };
    loadSnapshot.mockResolvedValue({
      cards: [{ schedule: JSON.stringify(learning), wordId: "w1" }],
      // Allowance spent.
      guesses: Array.from({ length: 15 }, (_, i) => ({
        reviewedAt: new Date().toISOString(),
        wordId: `introduced-${i}`,
      })),
      words: [CHIEN],
    });

    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    // Bounded practice does not pull future learning cards forward.
    await screen.findByRole("heading", { name: FINISHED });
    expect({
      saves: persistAnswer.mock.calls,
      textbox: screen.queryByRole("textbox"),
    }).toStrictEqual({ saves: [], textbox: null });
    expect(
      screen.getByRole("button", { name: /^(?:Finish|Termina)$/u })
    ).toBeDefined();

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    becomeVisible();
    expect({
      finished: screen.queryByRole("heading", { name: FINISHED }) !== null,
      loads: loadSnapshot.mock.calls.length,
      textbox: screen.queryByRole("textbox"),
    }).toStrictEqual({ finished: true, loads: 2, textbox: null });

    fireEvent.click(screen.getByRole("button", { name: CONTINUE_PRACTICING }));
    await screen.findByRole("textbox", {
      name: "scrivi la parola in francese",
    });
    expect(loadSnapshot).toHaveBeenCalledTimes(3);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "chien" },
    });
    fireEvent.click(screen.getByText("Normale"));
    await screen.findByRole("heading", { name: FINISHED });
    await waitFor(() => expect(persistAnswer).toHaveBeenCalledOnce());
  });

  it("does not accept answers against an old snapshot during a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-10T23:50:00"));
    const pending = deferred<ReviewSnapshot>();
    loadSnapshot
      .mockResolvedValueOnce(deck())
      .mockResolvedValueOnce(deck())
      .mockReturnValueOnce(pending.promise);
    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByText("cane");
    vi.setSystemTime(new Date("2026-08-11T07:30:00"));
    becomeVisible();
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("Continua")).toBeNull();
    await act(() => {
      pending.resolve(deck());
      return pending.promise;
    });
    await expect(screen.findByText("cane")).resolves.toBeDefined();
  });

  it("ignores a previous account's response after a keyed remount", async () => {
    const pending = deferred<ReviewSnapshot>();
    loadSnapshot.mockReturnValueOnce(pending.promise);
    loadSnapshot.mockResolvedValue(
      deck([{ ...CHIEN, gloss: "gatto", id: "w2", text: "chat" }])
    );
    const mounted = render(
      <SessionScreen transport={transport} key="u1" userId="u1" />
    );
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledOnce());
    mounted.rerender(
      <SessionScreen transport={transport} key="u2" userId="u2" />
    );
    await startSession();
    await screen.findByText("gatto");
    await act(() => {
      pending.resolve(deck());
      return pending.promise;
    });
    expect(screen.queryByText("cane")).toBeNull();
    expect(screen.getByText("gatto")).toBeDefined();
  });

  it("retries the same stored answer under its original account", async () => {
    persistAnswer.mockRejectedValueOnce(new Error("network down"));
    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByText("cane");
    fireEvent.click(screen.getByText("Continua"));
    await screen.findByText(/network down/u);
    expect(outboxKeys()).toHaveLength(1);
    const [first] = persistAnswer.mock.calls;
    expect(first?.[1]).toBe("u1");
    fireEvent.click(screen.getByRole("button", { name: "Riprova" }));
    await waitFor(() => expect(persistAnswer).toHaveBeenCalledTimes(2));
    expect(persistAnswer.mock.calls[1]).toStrictEqual(first);
    await waitFor(() => expect(outboxKeys()).toHaveLength(0));
    await screen.findByRole("heading", { name: FINISHED });
    expect(screen.queryByText("cane")).toBeNull();
  });

  it("preserves unsynced answers unless deletion is explicitly confirmed", async () => {
    const user = userEvent.setup();
    persistAnswer.mockRejectedValueOnce(new SyncConflict());
    render(
      <AppShell
        email="learner@example.com"
        section="session"
        onSectionChange={vi.fn<() => void>()}
        onSignOut={vi.fn<() => void>()}
      >
        <SessionScreen transport={transport} userId="u1" />
      </AppShell>
    );
    await startSession();
    await screen.findByText("cane");
    await user.click(screen.getByRole("button", { name: "Continua" }));
    const deleteLabel = "Elimina le risposte non sincronizzate e ricarica";
    const trigger = await screen.findByRole("button", { name: deleteLabel });
    expect(outboxKeys()).toHaveLength(1);

    await user.click(trigger);
    let dialog = await screen.findByRole("alertdialog", { name: deleteLabel });
    // App navigation must not suppress the recovery dialog's backdrop.
    expect({
      hasBackdrop:
        document.querySelector('[data-slot="alert-dialog-overlay"]') !== null,
      hasWarning:
        within(dialog).queryByText(/Non potrai recuperarle/u) !== null,
    }).toStrictEqual({ hasBackdrop: true, hasWarning: true });
    const cancel = within(dialog).getByRole("button", { name: "Annulla" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    await user.click(cancel);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect({
      loads: loadSnapshot.mock.calls.length,
      pending: outboxKeys().length,
    }).toStrictEqual({ loads: 2, pending: 1 });

    await user.click(trigger);
    dialog = await screen.findByRole("alertdialog", { name: deleteLabel });
    await user.click(within(dialog).getByRole("button", { name: deleteLabel }));
    await waitFor(() => expect(outboxKeys()).toHaveLength(0));
    await screen.findByRole("heading", { name: FINISHED });
    expect({
      answer: screen.queryByText("chien"),
      loads: loadSnapshot.mock.calls.length,
    }).toStrictEqual({ answer: null, loads: 3 });
    await user.click(screen.getByRole("button", { name: CONTINUE_PRACTICING }));
    await screen.findByRole("heading", { name: "chien" });
    expect({
      loads: loadSnapshot.mock.calls.length,
      textbox: screen.queryByRole("textbox"),
    }).toStrictEqual({ loads: 4, textbox: null });
  });

  it("recovers from a rejected local write without sending or losing the unanswered prompt", async () => {
    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByText("cane");
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage full");
      });

    expect(() => fireEvent.click(screen.getByText("Continua"))).not.toThrow();
    const alert = await screen.findByRole("alert");
    expect({
      alert: alert.textContent,
      answer: screen.queryByText("chien"),
      calls: persistAnswer.mock.calls,
      stored: outboxKeys().length,
      textbox: screen.queryByRole("textbox"),
    }).toStrictEqual({
      alert: "Non è stato possibile salvare le risposte: storage full",
      answer: null,
      calls: [],
      stored: 0,
      textbox: null,
    });

    write.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Riprova" }));
    await screen.findByText("cane");
    expect({
      alert: screen.queryByText(
        "Non è stato possibile salvare le risposte: storage full"
      ),
      calls: persistAnswer.mock.calls,
      loads: loadSnapshot.mock.calls.length,
      textbox: screen.queryByRole("textbox"),
    }).toStrictEqual({
      alert: null,
      calls: [],
      loads: 3,
      textbox: null,
    });

    fireEvent.click(screen.getByText("Continua"));
    await screen.findByRole("heading", { name: FINISHED });
    await waitFor(() => {
      expect({
        calls: persistAnswer.mock.calls,
        stored: outboxKeys().length,
      }).toStrictEqual({
        calls: [
          [expect.objectContaining({ phase: "teach", wordId: "w1" }), "u1"],
        ],
        stored: 0,
      });
    });
  });

  it("never exposes the stale prompt between clearing an error and starting a retry reload", async () => {
    const visiblePrompts: string[] = [];
    const { result } = renderHook(() => {
      const practice = usePracticeSession("u1", transport);
      if (
        !practice.writeError &&
        !practice.loadError &&
        practice.view?.phase === "exposure"
      ) {
        visiblePrompts.push(practice.view.prompt.gloss);
      }
      return practice;
    });
    await waitFor(() => expect(result.current.view?.phase).toBe("exposure"));
    act(() => result.current.block.start());
    const submitOldPrompt = result.current.exposureDone;
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage full");
      });
    act(() => result.current.exposureDone());
    expect(result.current.writeError).toBe("storage full");
    write.mockRestore();
    loadSnapshot.mockResolvedValue(
      deck([{ ...CHIEN, gloss: "gatto", id: "w2", text: "chat" }])
    );
    visiblePrompts.length = 0;
    await act(async () => {
      await result.current.retry();
    });
    await waitFor(() =>
      expect(result.current.view).toMatchObject({
        phase: "exposure",
        prompt: { gloss: "gatto" },
      })
    );
    expect(visiblePrompts).not.toContain("cane");
    act(() => submitOldPrompt());
    expect(result.current.view).toMatchObject({
      phase: "exposure",
      prompt: { gloss: "gatto" },
    });
    expect(persistAnswer).not.toHaveBeenCalled();
  });

  it.each([0, 60_000])(
    "does not reuse a cached snapshot, including clock skew of %i ms",
    async (clockSkew) => {
      queryClient.setQueryData(
        practiceKey("u1"),
        { settings: DEFAULT_SETTINGS, snapshot: deck([]) },
        { updatedAt: Date.now() + clockSkew }
      );
      render(<SessionScreen transport={transport} userId="u1" />);
      await startSession();
      await screen.findByText("cane");
      expect(loadSnapshot).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("heading", { name: FINISHED })).toBeNull();
    }
  );

  it("cancels a pre-existing read instead of joining a snapshot from before recovery", async () => {
    const stale = deferred<ReviewSnapshot>();
    loadSnapshot
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(deck())
      .mockResolvedValueOnce(deck());
    const olderRead = queryClient
      .query(practiceOptions("u1", transport))
      .catch(() => null);
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledOnce());
    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByText("cane");
    expect(loadSnapshot).toHaveBeenCalledTimes(3);
    await act(async () => {
      stale.resolve(deck([]));
      await olderRead;
    });
    expect(queryClient.getQueryData(practiceKey("u1"))).toMatchObject({
      snapshot: { words: [CHIEN] },
    });
    expect(screen.getByText("cane")).toBeDefined();
  });

  it("retries transient read failures but does not automatically retry permanent errors", async () => {
    loadSnapshot.mockRejectedValueOnce(new RetryableReadError("network down"));
    const mounted = render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByText("cane");
    expect(loadSnapshot).toHaveBeenCalledTimes(3);
    mounted.unmount();

    loadSnapshot.mockReset().mockRejectedValue(new Error("Session expired"));
    render(<SessionScreen transport={transport} userId="u1" />);
    await screen.findByText(/Session expired/u);
    expect(loadSnapshot).toHaveBeenCalledOnce();
  });

  it("stops retrying a transient read after three attempts and permits manual recovery", async () => {
    loadSnapshot.mockRejectedValue(new RetryableReadError("network down"));
    render(<SessionScreen transport={transport} userId="u1" />);
    await screen.findByText(/network down/u);
    expect(loadSnapshot).toHaveBeenCalledTimes(3);
    loadSnapshot.mockResolvedValue(deck());
    fireEvent.click(screen.getByRole("button", { name: "Riprova" }));
    await startSession();
    await screen.findByText("cane");
    expect(loadSnapshot).toHaveBeenCalledTimes(5);
  });

  it("does not replace an active session when query data changes or an answer is acknowledged", async () => {
    loadSnapshot.mockResolvedValue(
      deck([
        CHIEN,
        { ...CHIEN, freqRank: 2, gloss: "gatto", id: "w2", text: "chat" },
      ])
    );
    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByText("cane");
    fireEvent.click(screen.getByText("Continua"));
    await screen.findByText("chat");
    await waitFor(() => expect(outboxKeys()).toHaveLength(0));
    act(() =>
      queryClient.setQueryData(practiceKey("u1"), {
        settings: DEFAULT_SETTINGS,
        snapshot: deck([]),
      })
    );
    becomeVisible();
    window.dispatchEvent(new Event("online"));
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    expect(screen.getByText("chat")).toBeDefined();
  });

  it("aborts pending reads and removes private cache data when an account unmounts", async () => {
    const pending = deferred<ReviewSnapshot>();
    loadSnapshot.mockReturnValueOnce(pending.promise);
    const read = vi.spyOn(transport, "loadPractice");
    const mounted = render(<SessionScreen transport={transport} userId="u1" />);
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    const [userId, signal] = read.mock.calls[0] ?? [];
    expect(userId).toBe("u1");
    expect(signal?.aborted).toBeFalsy();
    mounted.unmount();
    expect(signal?.aborted).toBeTruthy();
    await act(async () => {
      pending.resolve(deck());
      await pending.promise;
    });
    expect(queryClient.getQueryState(practiceKey("u1"))).toBeUndefined();
  });

  it("clears the previous account's cache and does not expose it to the next account", async () => {
    const mounted = render(
      <SessionScreen key="u1" transport={transport} userId="u1" />
    );
    await startSession();
    await screen.findByText("cane");
    expect(queryClient.getQueryData(practiceKey("u1"))).toBeDefined();
    loadSnapshot.mockResolvedValue(
      deck([{ ...CHIEN, gloss: "gatto", id: "w2", text: "chat" }])
    );
    mounted.rerender(
      <SessionScreen key="u2" transport={transport} userId="u2" />
    );
    await startSession();
    await screen.findByText("gatto");
    expect(queryClient.getQueryState(practiceKey("u1"))).toBeUndefined();
    expect(queryClient.getQueryData(practiceKey("u2"))).toBeDefined();
    expect(screen.queryByText("cane")).toBeNull();
  });

  it("shows recoverable storage errors without deleting corrupt answers", async () => {
    const command: AnswerCommand = {
      expectedReps: 0,
      id: crypto.randomUUID(),
      latencyMs: 1,
      phase: "guess",
      rating: null,
      reviewedAt: new Date().toISOString(),
      typed: "",
      wordId: CHIEN.id,
    };
    const key = `vocab-builder:answer:v1:u1:${command.id}`;
    localStorage.setItem(key, "{broken");
    render(<SessionScreen transport={transport} userId="u1" />);
    await screen.findByText(/Risposte salvate nel browser non valide/u);
    expect({
      loads: loadSnapshot.mock.calls,
      saves: persistAnswer.mock.calls,
      stored: localStorage.getItem(key),
    }).toStrictEqual({ loads: [], saves: [], stored: "{broken" });
    fireEvent.click(screen.getByRole("button", { name: "Riprova" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Riprova" }).hasAttribute("disabled")
      ).toBeFalsy()
    );
    expect(localStorage.getItem(key)).toBe("{broken");

    localStorage.setItem(key, JSON.stringify(command));
    fireEvent.click(screen.getByRole("button", { name: "Riprova" }));
    await startSession();
    await screen.findByText("cane");
    expect(persistAnswer).toHaveBeenCalledExactlyOnceWith(command, "u1");
    expect(outboxKeys()).toHaveLength(0);
  });

  it("handles unavailable browser storage through recovery instead of crashing render", async () => {
    const storage = vi
      .spyOn(window, "localStorage", "get")
      .mockImplementation(() => {
        throw new Error("Storage access denied");
      });
    render(<SessionScreen transport={transport} userId="u1" />);
    await screen.findByText(/Storage access denied/u);
    expect(loadSnapshot).not.toHaveBeenCalled();
    storage.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "Riprova" }));
    await startSession();
    await screen.findByText("cane");
  });

  it("publishes detached views and ignores handlers from a previous view", async () => {
    loadSnapshot.mockResolvedValue(
      deck([
        CHIEN,
        { ...CHIEN, freqRank: 2, gloss: "gatto", id: "w2", text: "chat" },
      ])
    );
    const { result } = renderHook(() => usePracticeSession("u1", transport));
    await waitFor(() => expect(result.current.view?.phase).toBe("exposure"));
    act(() => result.current.block.start());
    const firstView = result.current.view;
    const submit = result.current.exposureDone;
    act(() => {
      submit();
      submit();
    });
    expect({
      before: firstView?.phase,
      error: result.current.writeError,
      phase: result.current.view?.phase,
    }).toStrictEqual({ before: "exposure", error: null, phase: "exposure" });
    expect(firstView).toMatchObject({ answer: "chien" });
    expect(result.current.view).toMatchObject({ answer: "chat" });
    await waitFor(() => expect(persistAnswer).toHaveBeenCalledOnce());
    act(() => submit());
    expect({
      error: result.current.writeError,
      phase: result.current.view?.phase,
      saves: persistAnswer.mock.calls.length,
    }).toStrictEqual({ error: null, phase: "exposure", saves: 1 });
  });

  it("ignores a previously rendered action after a background save fails", async () => {
    const pending = deferred<boolean>();
    persistAnswer.mockImplementationOnce(async () => {
      await pending.promise;
      throw new Error("offline");
    });
    const { result } = renderHook(() => usePracticeSession("u1", transport));
    await waitFor(() => expect(result.current.view?.phase).toBe("exposure"));
    act(() => result.current.block.start());
    act(() => result.current.exposureDone());
    const finishExposure = result.current.exposureDone;
    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    await waitFor(() => expect(result.current.writeError).toBe("offline"));
    act(() => finishExposure());
    expect({
      error: result.current.writeError,
      saves: persistAnswer.mock.calls.length,
      view: result.current.view,
    }).toStrictEqual({ error: "offline", saves: 1, view: undefined });
  });

  it("disables recovery while the same durable answer is being retried", async () => {
    const pending = deferred<undefined>();
    persistAnswer
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(pending.promise);
    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByText("cane");
    fireEvent.click(screen.getByText("Continua"));
    await screen.findByText(/offline/u);
    const retry = screen.getByRole("button", { name: "Riprova" });
    fireEvent.click(retry);
    expect(retry.hasAttribute("disabled")).toBeTruthy();
    fireEvent.click(retry);
    expect(persistAnswer).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("textbox")).toBeNull();
    await act(async () => {
      // eslint-disable-next-line unicorn/no-useless-undefined -- The deferred helper requires its generic value argument.
      pending.resolve(undefined);
      await pending.promise;
    });
    await screen.findByRole("heading", { name: FINISHED });
    expect(screen.queryByText("cane")).toBeNull();
    expect(persistAnswer.mock.calls[1]).toStrictEqual(
      persistAnswer.mock.calls[0]
    );
  });

  it("loads and advances under StrictMode without duplicating accepted answers", async () => {
    render(
      <StrictMode>
        <SessionScreen transport={transport} userId="u1" />
      </StrictMode>
    );
    await startSession();
    await screen.findByText("cane");
    fireEvent.click(screen.getByText("Continua"));
    await screen.findByRole("heading", { name: FINISHED });
    await waitFor(() => expect(outboxKeys()).toHaveLength(0));
    expect(persistAnswer).toHaveBeenCalledOnce();
  });

  it("reports a write failure it cannot act on", async () => {
    persistAnswer.mockRejectedValue(new Error("network down"));

    render(<SessionScreen transport={transport} userId="u1" />);
    await startSession();
    await screen.findByText("cane");
    // The teaching completion cannot be saved.
    fireEvent.click(screen.getByText("Continua"));

    await expect(screen.findByText(/network down/u)).resolves.toBeDefined();
  });
});
