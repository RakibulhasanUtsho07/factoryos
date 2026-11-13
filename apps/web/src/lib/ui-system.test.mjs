import test from "node:test";
import assert from "node:assert/strict";

import { cx } from "../components/ui/cx.mjs";

test("cx joins class tokens and ignores empty conditional values", () => {
  assert.equal(cx("rounded-lg", false, undefined, "px-4", null, "", "text-sm"), "rounded-lg px-4 text-sm");
});

test("cx preserves intentional class order", () => {
  assert.equal(cx("text-sm", "text-base", false, "font-semibold"), "text-sm text-base font-semibold");
});
