import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseSync, Visitor } from "oxc-parser";

const ignored = new Set(["node_modules", ".generated", ".wrangler", ".tanstack", "dist", "build"]);
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}
export function checkBoundaries(root: string): string[] {
  const workspaces = ["apps", "packages"].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const directory = join(root, group, entry.name);
        const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        return { directory, manifest };
      }),
  );
  const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]));
  const errors: string[] = [];
  for (const workspace of workspaces) {
    const allowed = new Set(
      Object.keys({
        ...workspace.manifest.dependencies,
        ...workspace.manifest.devDependencies,
        ...workspace.manifest.peerDependencies,
      }),
    );
    for (const file of files(workspace.directory)) {
      const path = relative(root, file);
      const testOnly = /\.test\.[jt]sx?$/.test(file) || file.endsWith("/src/testing.ts");
      const parsed = parseSync(file, readFileSync(file, "utf8"));
      for (const error of parsed.errors) errors.push(`${path}: ${error.message}`);
      function check(specifier: string) {
        const fail = (message: string) => errors.push(`${path}: ${message} (${specifier})`);
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(file), specifier);
          if (!target.startsWith(workspace.directory + "/"))
            fail("Use a public package export, not a relative cross-workspace import");
          // TanStack server functions are the only server import a browser feature may use.
          if (
            workspace.manifest.name === "@vocab/web" &&
            path.includes("/src/") &&
            !path.includes("/src/server/") &&
            !path.includes("/src/routes/api/") &&
            target.includes("/src/server/") &&
            !/\/server\/functions(?:\.ts)?$/.test(target)
          )
            fail("Browser code cannot import server implementation");
          if (
            workspace.manifest.name === "@vocab/authentication" &&
            file.endsWith("/src/client.ts") &&
            /\/server(?:\/|\.|$)/.test(target)
          )
            fail("Authentication client cannot import server implementation");
          return;
        }
        if (
          specifier === "cloudflare:workers" &&
          (file.endsWith("/src/client.ts") ||
            (workspace.manifest.name === "@vocab/web" &&
              path.includes("/src/") &&
              !path.includes("/src/server/") &&
              !path.includes("/src/routes/api/")))
        )
          fail("Worker bindings are server-only");
        if (/^(node:|bun:|cloudflare:)/.test(specifier)) return;
        const name = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0]!;
        if (!allowed.has(name) && name !== workspace.manifest.name) fail("Undeclared dependency");
        const dependency = byName.get(name);
        if (dependency) {
          const entry = specifier === name ? "." : "." + specifier.slice(name.length);
          if (!Object.hasOwn(dependency.manifest.exports ?? {}, entry))
            fail("Not a public package export");
          if (name === "@vocab/web") fail("Packages cannot depend on an application");
          if (entry === "./testing" && !testOnly)
            fail("Test utilities cannot enter production code");
          if (workspace.manifest.name === "@vocab/spaced-repetition")
            fail("The learning engine cannot depend on another workspace");
          if (workspace.manifest.name === "@vocab/database" && name !== "@vocab/spaced-repetition")
            fail("Database may depend only on the learning engine");
          if (workspace.manifest.name === "@vocab/authentication" && name !== "@vocab/database")
            fail("Authentication may depend only on database");
        }
        if (workspace.manifest.name === "@vocab/web") {
          if (
            [
              "drizzle-orm",
              "drizzle-kit",
              "better-auth",
              "@better-auth/drizzle-adapter",
              "ts-fsrs",
            ].includes(name)
          )
            fail("Use the owning module instead of its implementation library");
          if (
            path.includes("/src/") &&
            !path.includes("/src/server/") &&
            !path.includes("/src/routes/api/") &&
            !testOnly &&
            (name === "@vocab/database" ||
              specifier === "@vocab/authentication/server" ||
              specifier === "@vocab/spaced-repetition/server")
          )
            fail("Server-only entrypoint in browser code");
        }
        if (
          workspace.manifest.name === "@vocab/authentication" &&
          file.endsWith("/src/client.ts") &&
          name === "@vocab/database"
        )
          fail("Authentication client cannot depend on database");
      }
      new Visitor({
        ImportDeclaration: (node) => check(node.source.value),
        ExportAllDeclaration: (node) => check(node.source.value),
        ExportNamedDeclaration: (node) => {
          if (node.source) check(node.source.value);
        },
        ImportExpression: (node) => {
          if (node.source.type === "Literal" && typeof node.source.value === "string")
            check(node.source.value);
        },
        CallExpression: (node) => {
          if (
            node.callee.type === "Identifier" &&
            node.callee.name === "require" &&
            node.arguments[0]?.type === "Literal" &&
            typeof node.arguments[0].value === "string"
          )
            check(node.arguments[0].value);
        },
      }).visit(parsed.program);
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors = checkBoundaries(resolve(import.meta.dirname, ".."));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Package boundaries verified.");
}
