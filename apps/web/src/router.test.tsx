import { setupI18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import { useQueryClient } from "@tanstack/react-query";
import { attachRouterServerSsrUtils } from "@tanstack/react-router/ssr/server";
import { createI18n } from "@vocab/i18n";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createAppRouter } from "./router";

const LanguageProbe = () => {
  const { i18n } = useLingui();
  return <span>{i18n.locale}</span>;
};

const Probe = () => {
  const provided = useQueryClient();
  return <span>{provided.getQueryData<string>(["integration-test"])}</span>;
};

describe("router query integration", () => {
  it("isolates language instances across simultaneous requests", async () => {
    const [italian, english] = await Promise.all([
      createI18n("it"),
      createI18n("en"),
    ]);
    const first = createAppRouter(italian);
    const second = createAppRouter(english);
    expect(first.options.context?.i18n).not.toBe(second.options.context?.i18n);
    expect(first.options.context?.i18n.locale).toBe("it");
    expect(second.options.context?.i18n.locale).toBe("en");
    const First = first.options.Wrap;
    const Second = second.options.Wrap;
    if (!First || !Second) {
      throw new Error("Missing providers.");
    }
    expect(
      renderToString(
        <First>
          <LanguageProbe />
        </First>
      )
    ).toBe("<span>it</span>");
    expect(
      renderToString(
        <Second>
          <LanguageProbe />
        </Second>
      )
    ).toBe("<span>en</span>");
  });

  it("loads the server-selected catalog before browser hydration", async () => {
    const server = createAppRouter(await createI18n("it"), "u1");
    attachRouterServerSsrUtils({ manifest: undefined, router: server });
    const state = await server.options.dehydrate?.();
    server.serverSsr?.setRenderFinished();
    const client = createAppRouter(setupI18n());
    expect(state).toBeDefined();
    if (!state) {
      throw new Error("Missing dehydrated language.");
    }
    await client.options.hydrate?.(state);
    expect(client.options.context?.i18n.locale).toBe("it");
    expect(client.options.context?.documentIdentity.userId).toBe("u1");
    expect(client.options.context?.i18n.messages).toStrictEqual(
      server.options.context?.i18n.messages
    );
  });

  it("isolates cached data between SSR requests", () => {
    const first = createAppRouter(setupI18n());
    const second = createAppRouter(setupI18n());
    const firstClient = first.options.context?.queryClient;
    const secondClient = second.options.context?.queryClient;
    expect(firstClient).toBeDefined();
    expect(secondClient).toBeDefined();
    expect(firstClient).not.toBe(secondClient);
    firstClient?.setQueryData(["practice", "u1"], { private: "first request" });
    expect(secondClient?.getQueryData(["practice", "u1"])).toBeUndefined();
    firstClient?.clear();
    secondClient?.clear();
  });

  it("provides the router's query client to React without an extra provider", async () => {
    const router = createAppRouter(await createI18n("it"));
    const client = router.options.context?.queryClient;
    const Wrapper = router.options.Wrap;
    if (!Wrapper || !client) {
      throw new Error("Missing Query integration.");
    }
    client.setQueryData(["integration-test"], "ready");
    expect(
      renderToString(
        <Wrapper>
          <Probe />
        </Wrapper>
      )
    ).toBe("<span>ready</span>");
    client.clear();
  });
});
