import { createServerFn } from "@tanstack/react-start";
import {
  getRequestHeaders,
  setResponseHeader,
} from "@tanstack/react-start/server";
import type { UserRepository } from "@vocab/database";
import { AnswerCommand } from "@vocab/spaced-repetition";
import * as v from "valibot";

// Dynamic imports keep server-only packages and Worker bindings out of the browser graph.
const repository = async (expectedUserId?: string) => {
  const { services } = await import("./services");
  const { authentication, database } = services();
  const user = await authentication.requireUser(
    getRequestHeaders(),
    expectedUserId
  );
  return database.forUser(user.id);
};

type PracticeRepository = Pick<UserRepository, "settings" | "snapshot">;

/** Load one account-bound bootstrap through the authenticated repository boundary. */
export const readPractice = async (
  expectedUserId: string,
  resolveRepository: (expectedUserId: string) => Promise<PracticeRepository>
) => {
  const progress = await resolveRepository(expectedUserId);
  const settings = await progress.settings();
  const snapshot = await progress.snapshot(settings.lang);
  return { settings, snapshot };
};

export const getPractice = createServerFn({ method: "GET" })
  .validator(
    v.strictObject({
      expectedUserId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    })
  )
  .handler(({ data }) => {
    // Personalized responses must never enter a shared HTTP/CDN cache.
    setResponseHeader("Cache-Control", "private, no-store");
    return readPractice(data.expectedUserId, repository);
  });

export const recordAnswer = createServerFn({ method: "POST" })
  .validator(
    v.strictObject({
      answer: AnswerCommand,
      expectedUserId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    })
  )
  .handler(async ({ data }) => {
    // An old tab/outbox cannot submit one account's answers after another account signs in.
    const progress = await repository(data.expectedUserId);
    const { SaveConflict } = await import("@vocab/database");
    try {
      await progress.recordAnswer(data.answer);
      return { conflict: false };
    } catch (error) {
      if (error instanceof SaveConflict) {
        return { conflict: true };
      }
      throw error;
    }
  });
