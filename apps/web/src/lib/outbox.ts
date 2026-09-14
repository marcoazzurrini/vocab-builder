import * as v from "valibot";
import { AnswerCommand } from "@vocab/study/commands";

/** Durable, user-scoped, ordered answers. A failure blocks later answers until retry succeeds. */
export function createOutbox(options: {
  userId: string;
  storage: Storage;
  send: (answer: AnswerCommand) => Promise<unknown>;
  onError: (error: Error) => void;
}) {
  const prefix = `vocab-builder:answer:v1:${encodeURIComponent(options.userId)}:`;
  const items: AnswerCommand[] = [];
  for (let i = 0; i < options.storage.length; i++) {
    const key = options.storage.key(i);
    if (key?.startsWith(prefix)) {
      const raw = options.storage.getItem(key);
      if (raw) items.push(v.parse(AnswerCommand, JSON.parse(raw)));
    }
  }
  items.sort(
    (a, b) =>
      a.reviewedAt.localeCompare(b.reviewedAt) ||
      a.expectedReps - b.expectedReps ||
      Number(a.phase === "recall") - Number(b.phase === "recall"),
  );
  let running: Promise<void> | undefined;
  let failure: Error | undefined;

  function persist(answer: AnswerCommand) {
    // One key per answer: another tab acknowledging its answer cannot erase ours.
    options.storage.setItem(prefix + answer.id, JSON.stringify(answer));
  }
  function drain(): Promise<void> {
    if (running) return running;
    running = (async () => {
      while (items.length && !failure) {
        const answer = items[0]!;
        try {
          persist(answer);
          await options.send(answer);
          options.storage.removeItem(prefix + answer.id);
          items.shift();
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          options.onError(failure);
        }
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    push(command: AnswerCommand) {
      const answer = v.parse(AnswerCommand, structuredClone(command));
      items.push(answer);
      try {
        persist(answer);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        options.onError(failure);
      }
      void drain();
    },
    get pending() {
      return items.length;
    },
    async settled() {
      await drain();
      if (failure) throw failure;
    },
    async retry() {
      failure = undefined;
      await drain();
      if (failure) throw failure;
    },
    discard() {
      if (running) throw new Error("Wait for the current save before discarding pending answers.");
      for (const answer of items) options.storage.removeItem(prefix + answer.id);
      items.length = 0;
      failure = undefined;
    },
  };
}
