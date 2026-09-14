import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const publicDirectory = new URL("../public/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.webmanifest", publicDirectory), "utf8"));

function pngDimensions(path: string) {
  const image = readFileSync(new URL(path.replace(/^\//, ""), publicDirectory));
  expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(image.toString("ascii", 12, 16)).toBe("IHDR");
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

describe("online-only PWA installation assets", () => {
  it("uses a stable identity and launches the existing app in standalone mode", () => {
    expect(manifest).toMatchObject({
      id: "/",
      name: "Vocab Builder",
      short_name: "Vocab",
      lang: "it",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#f4f4f1",
      theme_color: "#f4f4f1",
    });
    expect(manifest.prefer_related_applications).not.toBe(true);
  });

  it.each([192, 512])("ships a real %ipx PNG matching the manifest", (size) => {
    const icon = manifest.icons.find(
      (entry: { sizes: string }) => entry.sizes === `${size}x${size}`,
    );
    expect(icon).toMatchObject({ type: "image/png" });
    expect(icon.purpose.split(" ")).toContain("any");
    expect(pngDimensions(icon.src)).toEqual({ width: size, height: size });
    if (size === 512) expect(icon.purpose.split(" ")).toContain("maskable");
  });

  it("ships a 180px Apple touch icon", () => {
    expect(pngDimensions("/icons/apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
  });
});
