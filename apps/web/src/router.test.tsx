import { useQueryClient } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { getRouter } from "./router";

const Probe = () => {
  const provided = useQueryClient();
  return <span>{provided.getQueryData<string>(["integration-test"])}</span>;
};

describe("router query integration", () => {
  it("isolates cached data between SSR requests", () => {
    const first = getRouter();
    const second = getRouter();
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

  it("provides the router's query client to React without an extra provider", () => {
    const router = getRouter();
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
