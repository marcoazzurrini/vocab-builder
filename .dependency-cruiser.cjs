/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-unresolved-imports",
      comment: "Resolve package exports instead of allowing imports into private source.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-undeclared-external-dependencies",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "no-relative-cross-workspace-imports",
      comment: "Cross-workspace imports must use a public package entrypoint.",
      severity: "error",
      from: { path: "^((?:apps|packages)/[^/]+)/" },
      to: {
        pathNot: "^$1/",
        dependencyTypes: ["local"],
      },
    },
    {
      name: "packages-cannot-import-apps",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "spaced-repetition-is-independent",
      severity: "error",
      from: { path: "^packages/spaced-repetition/" },
      to: { path: "^packages/", pathNot: "^packages/spaced-repetition/" },
    },
    {
      name: "database-only-depends-on-spaced-repetition",
      severity: "error",
      from: { path: "^packages/database/" },
      to: { path: "^packages/", pathNot: "^packages/(database|spaced-repetition)/" },
    },
    {
      name: "authentication-only-depends-on-database",
      severity: "error",
      from: { path: "^packages/authentication/" },
      to: { path: "^packages/", pathNot: "^packages/(authentication|database)/" },
    },
    {
      name: "web-uses-module-interfaces",
      severity: "error",
      from: { path: "^apps/web/" },
      to: {
        path: "(^|/)(drizzle-orm|drizzle-kit|better-auth|@better-auth/drizzle-adapter|ts-fsrs)(/|$)",
      },
    },
    {
      name: "test-infrastructure-stays-in-tests",
      severity: "error",
      from: { pathNot: "\\.test\\.[cm]?[jt]sx?$|/src/testing\\.ts$" },
      to: { path: "^packages/[^/]+/src/testing\\.ts$|\\.test\\.[cm]?[jt]sx?$" },
    },
    {
      name: "web-client-cannot-import-server-implementation",
      comment: "TanStack transforms server/functions.ts into the browser's HTTP transport.",
      severity: "error",
      from: {
        path: "^apps/web/src/",
        pathNot: "^apps/web/src/(server|routes/api)/|\\.test\\.[cm]?[jt]sx?$",
      },
      to: {
        path: "^apps/web/src/server/|^packages/database/|^packages/(authentication|spaced-repetition)/src/server\\.ts$|^cloudflare:",
        pathNot: "^apps/web/src/server/functions\\.ts$",
      },
    },
    {
      name: "public-client-entrypoints-stay-browser-safe",
      comment: "Also reject indirect imports through shared helpers and re-exports.",
      severity: "error",
      from: {
        path: "^packages/(authentication/src/client|spaced-repetition/src/index)\\.ts$",
      },
      to: {
        path: "^packages/database/|^packages/(authentication|spaced-repetition)/src/server\\.ts$|^cloudflare:",
        reachable: true,
      },
    },
  ],
  options: {
    // Include type-only imports in the architecture rules.
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    exclude: {
      // Exclude our build output, not dependencies' dist/ entrypoints.
      path: "^(apps|packages)/[^/]+/(\\.generated|\\.wrangler|\\.tanstack|\\.cache|dist|build)/|(^|/)routeTree\\.gen(?:\\.ts)?$",
    },
    builtInModules: { add: ["cloudflare:workers"] },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
