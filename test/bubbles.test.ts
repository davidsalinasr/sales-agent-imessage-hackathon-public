import { test } from "node:test";
import assert from "node:assert/strict";
import { toBubbles } from "../lib/linq";

test("splits on blank lines and keeps lists together", () => {
  assert.deepEqual(toBubbles("Done ✅\n\n• one\n• two\n\nWant the Doc?"), ["Done ✅", "• one\n• two", "Want the Doc?"]);
});

test("a single paragraph stays one bubble", () => {
  assert.deepEqual(toBubbles("  just this  "), ["just this"]);
});

test("caps bubbles by folding extras into the last one", () => {
  const out = toBubbles(["a", "b", "c", "d", "e", "f", "g"].join("\n\n"));
  assert.equal(out.length, 5);
  assert.equal(out[4], "e\n\nf\n\ng");
});

test("a bare URL line becomes its own bubble", () => {
  assert.deepEqual(toBubbles("Listo ✅ aquí está el doc\nhttps://docs.google.com/document/d/abc/edit\n\nAlgo más?"), [
    "Listo ✅ aquí está el doc",
    "https://docs.google.com/document/d/abc/edit",
    "Algo más?",
  ]);
});
