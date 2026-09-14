import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import * as v from "valibot";
import { AnswerCommand } from "@vocab/spaced-repetition";

// Dynamic imports keep server-only packages and Worker bindings out of the browser graph.
async function repository(expectedUserId?: string) {
  const { services } = await import("./services");
  const { authentication, database } = services();
  const user = await authentication.requireUser(getRequestHeaders(), expectedUserId);
  return database.forUser(user.id);
}

export const getSettings = createServerFn({ method: "GET" }).handler(async () => {
  return (await repository()).settings();
});

export const getSnapshot = createServerFn({ method: "GET" })
  .validator(v.strictObject({ lang: v.pipe(v.string(), v.minLength(2), v.maxLength(16)) }))
  .handler(async ({ data }) => (await repository()).snapshot(data.lang));

export const recordAnswer = createServerFn({ method: "POST" })
  .validator(
    v.strictObject({
      expectedUserId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
      answer: AnswerCommand,
    }),
  )
  .handler(async ({ data }) => {
    // An old tab/outbox cannot submit one account's answers after another account signs in.
    const progress = await repository(data.expectedUserId);
    const { SaveConflict } = await import("@vocab/database");
    try {
      await progress.recordAnswer(data.answer);
      return { conflict: false };
    } catch (error) {
      if (error instanceof SaveConflict) return { conflict: true };
      throw error;
    }
  });
