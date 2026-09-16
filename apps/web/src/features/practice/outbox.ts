import { AnswerCommand } from "@vocab/spaced-repetition";
import * as v from "valibot";

// Metadata and the unchanged domain command are accepted in one durable write.
// Sequences preserve this queue's FIFO across reloads, not global ordering between
// concurrent tabs. Ties use IDs for deterministic replay; the server detects conflicts.
const StoredAnswer = v.strictObject({
  answer: AnswerCommand,
  sequence: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(Number.MAX_SAFE_INTEGER)
  ),
});

interface PendingAnswer {
  answer: AnswerCommand;
  key: string;
  sequence: number | undefined;
}

/** Durable, user-scoped, ordered answers. A failure blocks later answers until retry succeeds. */
export const createOutbox = (options: {
  userId: string;
  storage: () => Storage;
  send: (answer: AnswerCommand) => Promise<void>;
  onError: (error: Error) => void;
}) => {
  const prefix = `vocab-builder:answer:v2:${encodeURIComponent(options.userId)}:`;
  const legacyPrefix = `vocab-builder:answer:v1:${encodeURIComponent(options.userId)}:`;
  let items: PendingAnswer[] = [];
  let sequence = 0;
  let hydrationError: Error | undefined;
  let running: Promise<void> | undefined;
  let failure: Error | undefined;

  const readStored = (): PendingAnswer[] => {
    const stored: PendingAnswer[] = [];
    const storage = options.storage();
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key || (!key.startsWith(prefix) && !key.startsWith(legacyPrefix))) {
        continue;
      }
      const raw = storage.getItem(key);
      if (raw === null) {
        continue;
      }
      try {
        const legacy = key.startsWith(legacyPrefix);
        const record = legacy
          ? {
              answer: v.parse(AnswerCommand, JSON.parse(raw)),
              sequence: undefined,
            }
          : v.parse(StoredAnswer, JSON.parse(raw));
        if (key !== (legacy ? legacyPrefix : prefix) + record.answer.id) {
          throw new Error("Stored answer ID does not match its key.");
        }
        stored.push({ ...record, key });
      } catch (error) {
        // Never remove an unreadable record or send only part of a damaged queue.
        throw new Error(
          "Risposte salvate nel browser non valide. I dati sono stati conservati; riprova dopo averli recuperati.",
          { cause: error }
        );
      }
    }
    return stored;
  };

  const hydrate = () => {
    try {
      const stored = readStored();
      stored.sort((a, b) => {
        if (a.sequence !== undefined && b.sequence !== undefined) {
          return (
            a.sequence - b.sequence || a.answer.id.localeCompare(b.answer.id)
          );
        }
        if (a.sequence !== undefined || b.sequence !== undefined) {
          return a.sequence === undefined ? -1 : 1;
        }
        // Legacy records have no recoverable FIFO order. Preserve per-card
        // dependencies first, even if their wall-clock timestamps went backwards.
        return (
          a.answer.expectedReps - b.answer.expectedReps ||
          Number(a.answer.phase === "recall") -
            Number(b.answer.phase === "recall") ||
          a.answer.reviewedAt.localeCompare(b.answer.reviewedAt) ||
          a.answer.id.localeCompare(b.answer.id)
        );
      });
      items = stored;
      sequence = Math.max(
        sequence,
        ...stored.map((item) => item.sequence ?? 0)
      );
      hydrationError = undefined;
    } catch (error) {
      hydrationError =
        error instanceof Error ? error : new Error(String(error));
    }
  };
  // Initialization must not throw into React rendering or notify it during render.
  hydrate();

  const sendPending = async (): Promise<void> => {
    while (!failure) {
      if (hydrationError) {
        break;
      }
      const [item] = items;
      if (!item) {
        break;
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- Acknowledgment must precede the next send; failures block later answers.
        await options.send(structuredClone(item.answer));
        options.storage().removeItem(item.key);
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
        do {
          // Await even an empty queue so running is assigned before cleanup.
          // A push can join this drain after sendPending ends but before we resume.
          // eslint-disable-next-line no-await-in-loop -- Include commands accepted during drain completion in the same drain.
          await sendPending();
          // sendPending can fail or finish just before another push joins us.
          if (failure || hydrationError) {
            break;
          }
        } while (items.length > 0);
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
      if (hydrationError) {
        throw hydrationError;
      }
      for (const { key } of items) {
        options.storage().removeItem(key);
      }
      items.length = 0;
      failure = undefined;
    },
    get needsRecovery() {
      return failure !== undefined || hydrationError !== undefined;
    },
    get pending() {
      // Unreadable durable data also requires the beforeunload warning.
      return hydrationError ? Math.max(1, items.length) : items.length;
    },
    push(command: AnswerCommand) {
      if (hydrationError) {
        throw hydrationError;
      }
      const answer = v.parse(AnswerCommand, structuredClone(command));
      const payload = JSON.stringify(answer);
      const existing = items.find((item) => item.answer.id === answer.id);
      // Observe sequence numbers and duplicates written by other tabs too.
      let stored: PendingAnswer[];
      try {
        stored = readStored();
      } catch (error) {
        hydrationError =
          error instanceof Error ? error : new Error(String(error));
        throw hydrationError;
      }
      const duplicate = stored.find((item) => item.answer.id === answer.id);
      if (
        (existing && JSON.stringify(existing.answer) !== payload) ||
        (duplicate && JSON.stringify(duplicate.answer) !== payload)
      ) {
        throw new Error(
          "An answer with this ID already has a different payload."
        );
      }
      if (existing) {
        return;
      }

      // A failed new write must leave both session and queue unchanged.
      let item = duplicate;
      if (!item) {
        const next =
          Math.max(sequence, ...stored.map((entry) => entry.sequence ?? 0)) + 1;
        const record = v.parse(StoredAnswer, { answer, sequence: next });
        const key = prefix + answer.id;
        options.storage().setItem(key, JSON.stringify(record));
        sequence = next;
        item = { ...record, key };
      }
      // Adopt an identical durable answer written by another tab, so settled()
      // covers everything this queue accepted. Server retries are idempotent.
      items.push(item);
      void drain();
    },
    async retry() {
      if (hydrationError) {
        // A corruption discovered by push may overlap an earlier send. Let its
        // acknowledgment finish before replacing the in-memory queue from storage.
        await running;
        if (hydrationError) {
          hydrate();
        }
      }
      if (hydrationError) {
        throw hydrationError;
      }
      failure = undefined;
      await drain();
      if (failure || hydrationError) {
        throw failure ?? hydrationError;
      }
    },
    async settled() {
      if (hydrationError) {
        throw hydrationError;
      }
      await drain();
      if (failure || hydrationError) {
        throw failure ?? hydrationError;
      }
    },
  };
};
