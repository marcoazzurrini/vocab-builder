import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const [target, email = "learner@example.com"] = process.argv.slice(2);
if (!target) {
  throw new Error("Provide the target development environment file.");
}
if (!/^[^\s@=]+@[^\s@=]+\.[^\s@=]+$/u.test(email)) {
  throw new Error("Provide a valid email address.");
}
await writeFile(
  target,
  [
    "BETTER_AUTH_URL=http://localhost:5173",
    `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}`,
    `ALLOWED_EMAILS=${email}`,
    "AUTH_EMAIL_MODE=log",
    "",
  ].join("\n"),
  { flag: "wx", mode: 0o600 }
);
console.log(
  "Created .dev.vars. Local sign-in links appear only in the development terminal."
);
