import test from "node:test";
import assert from "node:assert/strict";
import { collectOwners } from "../lib/bot-access.js";
import { config } from "../config.js";

test("collectOwners merges .env OWNER_NUMBER, db extra and bot number", () => {
  const db = { setting: (k) => (k === "ownerNumbers" ? ["628111"] : undefined) };
  const fake = { owner: { number: ["628222", "628111"] }, bot: { number: "628333" } };
  assert.deepEqual(collectOwners({ config: fake, db }), ["628222", "628111", "628333"]);
});

test("collectOwners tolerates a missing db and empty config", () => {
  assert.deepEqual(collectOwners({ config: {}, db: { setting: () => { throw new Error("x"); } } }), []);
});

test("real config exposes OWNER_NUMBER as an array", () => {
  assert.ok(Array.isArray(config.owner?.number));
});
