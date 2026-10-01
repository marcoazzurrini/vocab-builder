import { expect, it } from "bun:test";

import { testDatabase } from "./testing";

it("keeps temporary batch statements alive during concurrent requests and garbage collection", async () => {
  const fixture = await testDatabase();
  const collector = setInterval(() => Bun.gc(true), 10);
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, batch) =>
        fixture.binding.batch<{ value: number }>(
          Array.from({ length: 8 }, (_statement, index) =>
            fixture.binding.prepare("SELECT ? AS value").bind(batch * 8 + index)
          )
        )
      )
    );
    expect(
      results.flatMap((batch) => batch.flatMap((result) => result.results))
    ).toEqual(Array.from({ length: 160 }, (_, value) => ({ value })));
  } finally {
    clearInterval(collector);
    await fixture.close();
  }
});
