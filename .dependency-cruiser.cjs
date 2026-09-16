/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      comment:
        "Resolve package exports instead of allowing imports into private source.",
      from: {},
      name: "no-unresolved-imports",
      severity: "error",
      to: { couldNotResolve: true },
    },
    {
      from: {},
      name: "no-undeclared-external-dependencies",
      severity: "error",
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      comment: "Cross-workspace imports must use a public package entrypoint.",
      from: { path: "^((?:apps|packages)/[^/]+)/" },
      name: "no-relative-cross-workspace-imports",
      severity: "error",
      to: {
        dependencyTypes: ["local"],
        pathNot: "^$1/",
      },
    },
    {
      from: { path: "^packages/" },
      name: "packages-cannot-import-apps",
      severity: "error",
      to: { path: "^apps/" },
    },
    {
      from: { path: "^packages/spaced-repetition/" },
      name: "spaced-repetition-is-independent",
      severity: "error",
      to: { path: "^packages/", pathNot: "^packages/spaced-repetition/" },
    },
    {
      from: { path: "^packages/database/" },
      name: "database-only-depends-on-spaced-repetition",
      severity: "error",
      to: {
        path: "^packages/",
        pathNot: "^packages/(database|spaced-repetition)/",
      },
    },
    {
      from: { path: "^packages/authentication/" },
      name: "authentication-only-depends-on-database",
      severity: "error",
      to: {
        path: "^packages/",
        pathNot: "^packages/(authentication|database)/",
      },
    },
    {
      from: { path: "^apps/web/" },
      name: "web-uses-module-interfaces",
      severity: "error",
      to: {
        path: "(^|/)(drizzle-orm|drizzle-kit|better-auth|@better-auth/drizzle-adapter|ts-fsrs)(/|$)",
      },
    },
    {
      from: {
        pathNot:
          "\\.test\\.[cm]?[jt]sx?$|/src/testing\\.ts$|^packages/[^/]+/tests/",
      },
      name: "test-infrastructure-stays-in-tests",
      severity: "error",
      to: {
        path: "^packages/[^/]+/(src/testing\\.ts$|tests/)|\\.test\\.[cm]?[jt]sx?$",
      },
    },
    {
      comment:
        "TanStack transforms server/functions.ts into the browser's HTTP transport.",
      from: {
        path: "^apps/web/src/",
        pathNot: "^apps/web/src/(server|routes/api)/|\\.test\\.[cm]?[jt]sx?$",
      },
      name: "web-client-cannot-import-server-implementation",
      severity: "error",
      to: {
        path: "^apps/web/src/server/|^packages/database/|^packages/authentication/src/server\\.ts$|^packages/spaced-repetition/src/evaluate-answer\\.ts$|^cloudflare:",
        pathNot: "^apps/web/src/server/functions\\.ts$",
      },
    },
    {
      comment:
        "Also reject indirect imports through shared helpers and re-exports.",
      from: {
        path: "^packages/(authentication/src/client|spaced-repetition/src/index)\\.ts$",
      },
      name: "public-client-entrypoints-stay-browser-safe",
      severity: "error",
      to: {
        path: "^packages/database/|^packages/authentication/src/server\\.ts$|^packages/spaced-repetition/src/evaluate-answer\\.ts$|^cloudflare:",
        reachable: true,
      },
    },
  ],
  options: {
    builtInModules: { add: ["cloudflare:workers"] },
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: {
      conditionNames: ["import", "require", "node", "default"],
      exportsFields: ["exports"],
    },
    exclude: {
      // Exclude our build output, not dependencies' dist/ entrypoints.
      path: "^(apps|packages)/[^/]+/(\\.generated|\\.wrangler|\\.tanstack|\\.cache|dist|build)/|(^|/)routeTree\\.gen(?:\\.ts)?$",
    },
    // Include type-only imports in the architecture rules.
    tsPreCompilationDeps: true,
  },
};
