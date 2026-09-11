import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import * as v from "valibot";
import { AnswerCommand } from "../lib/commands";

// Imports inside handlers stay on the server. No database binding or secret enters the client bundle.
async function context(expectedUserId?: string) {
  const { env } = await import("cloudflare:workers");
  const { createAuth, authenticatedUser } = await import("./auth");
  const { database } = await import("./db/repository");
  const user = await authenticatedUser(createAuth(env), getRequestHeaders(), expectedUserId);
  return { db: database(env.DB), userId: user.id };
}

export const getSettings = createServerFn({ method: "GET" }).handler(async () => {
  const { db, userId } = await context();
  const { readSettings } = await import("./db/repository");
  return readSettings(db, userId);
});

export const getDeck = createServerFn({ method: "GET" })
  .validator(v.strictObject({ lang: v.pipe(v.string(), v.minLength(2), v.maxLength(16)) }))
  .handler(async ({ data }) => {
    const { db, userId } = await context();
    const { readDeck } = await import("./db/repository");
    return readDeck(db, userId, data.lang);
  });

export const recordAnswer = createServerFn({ method: "POST" })
  .validator(
    v.strictObject({
      expectedUserId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
      answer: AnswerCommand,
    }),
  )
  .handler(async ({ data }) => {
    // An old tab/outbox must not submit one account's answers after another account signs in.
    const { db, userId } = await context(data.expectedUserId);
    const { saveAnswer, SaveConflict } = await import("./db/repository");
    try {
      await saveAnswer(db, userId, data.answer);
      return { conflict: false };
    } catch (error) {
      if (error instanceof SaveConflict) return { conflict: true };
      throw error;
    }
  });
