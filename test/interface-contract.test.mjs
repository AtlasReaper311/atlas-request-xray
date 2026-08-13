import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the browser shell advertises the Atlas external page contract", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /<title>XRAY \/\/ ATLAS SYSTEMS<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/xray\.atlas-systems\.uk\/">/);
  assert.match(html, /<link rel="manifest" href="\/site\.webmanifest">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/atlas-systems\.uk\/og\/request-xray\.png">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /data-atlas-status/);
  assert.match(html, /data-estate-search-open/);
});

test("runtime assets are repository-local", async () => {
  const css = await readFile(new URL("../css/xray.css", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../site.webmanifest", import.meta.url), "utf8"));
  const headers = await readFile(new URL("../_headers", import.meta.url), "utf8");

  assert.doesNotMatch(css, /fonts\.googleapis|fonts\.gstatic|@import url/i);
  assert.deepEqual(manifest.icons.map((icon) => icon.src), [
    "/android-chrome-192x192.png",
    "/android-chrome-512x512.png",
  ]);
  assert.match(headers, /Strict-Transport-Security:/);
  assert.match(headers, /Content-Security-Policy:/);
});
