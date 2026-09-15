import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const publicDirectory = new URL("../public/", import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL("manifest.webmanifest", publicDirectory), "utf-8")
);

const pngDimensions = (path: string) => {
  const image = readFileSync(
    new URL(path.replace(/^\//u, ""), publicDirectory)
  );
  expect(image.subarray(0, 8)).toStrictEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  );
  expect(image.toString("ascii", 12, 16)).toBe("IHDR");
  return { height: image.readUInt32BE(20), width: image.readUInt32BE(16) };
};

describe("online-only PWA installation assets", () => {
  it("uses a stable identity and launches the existing app in standalone mode", () => {
    expect(manifest).toMatchObject({
      background_color: "#f4f4f1",
      display: "standalone",
      id: "/",
      lang: "it",
      name: "Vocab Builder",
      scope: "/",
      short_name: "Vocab",
      start_url: "/",
      theme_color: "#f4f4f1",
    });
    expect(manifest.prefer_related_applications).not.toBeTruthy();
  });

  it.each([192, 512])("ships a real %ipx PNG matching the manifest", (size) => {
    const icon = manifest.icons.find(
      (entry: { sizes: string }) => entry.sizes === `${size}x${size}`
    );
    expect(icon).toMatchObject({ type: "image/png" });
    expect(icon.purpose.split(" ")).toContain("any");
    expect(pngDimensions(icon.src)).toStrictEqual({
      height: size,
      width: size,
    });
  });

  it("provides a maskable 512px icon", () => {
    const icon = manifest.icons.find(
      (entry: { sizes: string }) => entry.sizes === "512x512"
    );
    expect(icon.purpose.split(" ")).toContain("maskable");
  });

  it("ships a 180px Apple touch icon", () => {
    expect(pngDimensions("/icons/apple-touch-icon.png")).toStrictEqual({
      height: 180,
      width: 180,
    });
  });
});
