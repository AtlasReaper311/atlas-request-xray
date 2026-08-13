import assert from "node:assert/strict";
import test from "node:test";

import { isAtlasOwnedHost } from "../src/estate-search.js";

test("Atlas-owned host checks require an exact host or dot boundary", () => {
  assert.equal(isAtlasOwnedHost("atlas-systems.uk"), true);
  assert.equal(isAtlasOwnedHost("status.atlas-systems.uk"), true);
  assert.equal(isAtlasOwnedHost("evil-atlas-systems.uk"), false);
  assert.equal(isAtlasOwnedHost("atlas-systems.uk.evil.example"), false);
});
