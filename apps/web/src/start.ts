import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

import { languageMiddleware } from "./server/language";

const csrfMiddleware = createCsrfMiddleware({
  filter: ({ handlerType }) => handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, languageMiddleware],
}));
