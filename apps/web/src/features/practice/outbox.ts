import { AnswerCommand } from "@vocab/spaced-repetition";
import * as v from "valibot";

/** Durable, user-scoped, ordered answers. A failure blocks later answers until retry succeeds. */
export const createOutbox = (options: {
  userId: string;
  storage: Storage;
  send: (answer: AnswerCommand) => Promise<void>;
  onError: (error: Error) => void;
}) => {
  const prefix = `vocab-builder:answer:v1:${encodeURIComponent(options.userId)}:`;
  const items: AnswerCommand[] = [];
  for (let i = 0; i < options.storage.length; i += 1) {
    const key = options.storage.key(i);
    if (key?.startsWith(prefix)) {
      const raw = options.storage.getItem(key);
      if (raw) {
        items.push(v.parse(AnswerCommand, JSON.parse(raw)));
      }
    }
  }
  items.sort(
    (a, b) =>
      a.reviewedAt.localeCompare(b.reviewedAt) ||
      a.expectedReps - b.expectedReps ||
      Number(a.phase === "recall") - Number(b.phase === "recall")
  );
  let running: Promise<void> | undefined;
  let failure: Error | undefined;

  const sendPending = async (): Promise<void> => {
    while (!failure) {
      const [answer] = items;
      if (!answer) {
        break;
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- Acknowledgment must precede the next send; failures block later answers.
        await options.send(structuredClone(answer));
        options.storage.removeItem(prefix + answer.id);
        items.shift();
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        try {
          options.onError(failure);
        } catch {
          // Notifications cannot undo durable acceptance or break retry handling.
        }
      }
    }
  };

  const drain = (): Promise<void> => {
    if (running) {
      return running;
    }
    running = (async () => {
      try {
        // Await even an empty queue or synchronous send failure so running is assigned before cleanup.
        await sendPending();
      } finally {
        running = undefined;
      }
    })();
    return running;
  };

  return {
    discard() {
      if (running) {
        throw new Error(
          "Wait for the current save before discarding pending answers."
        );
      }
      for (const answer of items) {
        options.storage.removeItem(prefix + answer.id);
      }
      items.length = 0;
      failure = undefined;
    },
    get pending() {
      return items.length;
    },
    push(command: AnswerCommand) {
      const answer = v.parse(AnswerCommand, structuredClone(command));
      const payload = JSON.stringify(answer);
      const existing = items.find((item) => item.id === answer.id);
      const stored = options.storage.getItem(prefix + answer.id);
      if (
        (existing && JSON.stringify(existing) !== payload) ||
        (stored !== null &&
          JSON.stringify(v.parse(AnswerCommand, JSON.parse(stored))) !==
            payload)
      ) {
        throw new Error(
          "An answer with this ID already has a different payload."
        );
      }
      if (existing) {
        return;
      }

      // Adopt an identical durable answer written by another tab, so settled()
      // covers everything this queue accepted. Server retries are idempotent.
      // A failed new write must leave both session and queue unchanged.
      if (stored === null) {
        options.storage.setItem(prefix + answer.id, payload);
      }
      items.push(answer);
      void drain();
    },
    async retry() {
      failure = undefined;
      await drain();
      if (failure) {
        throw failure;
      }
    },
    async settled() {
      await drain();
      if (failure) {
        throw failure;
      }
    },
  };
};
