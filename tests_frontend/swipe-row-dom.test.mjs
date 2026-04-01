import test from "node:test";
import assert from "node:assert/strict";

import { initSwipeRow } from "../static/js/modules/swipe-row.mjs";
import {
  createSwipeRowFixture,
  createTouchEvent,
  installDomGlobals
} from "./dom-helpers.mjs";

test("weight swipe rows open action buttons on partial swipe", async () => {
  const dom = installDomGlobals({ innerWidth: 200 });
  const fixture = createSwipeRowFixture({
    actionsSelector: ".weight-pill-actions",
    attributes: { "data-weight-id": "weight-1" },
    buttonSelector: ".weight-pill-btn",
    contentSelector: ".weight-row-content",
    deleteSelector: ".weight-pill-btn.delete"
  });

  dom.setComputedStyle(fixture.actions, { columnGap: "8px", gap: "8px", right: "0px" });
  dom.setComputedStyle(fixture.content, { transitionDuration: "0.2s", transitionDelay: "0s" });
  for (let i = 0; i < fixture.buttons.length; i += 1) {
    dom.setComputedStyle(fixture.buttons[i], { width: "48px" });
  }

  let openRow = null;
  initSwipeRow(fixture.row, {
    actionsSelector: ".weight-pill-actions",
    buttonSelector: ".weight-pill-btn",
    config: {
      SNAP_PX: 52,
      FULL_FRAC: 0.72,
      DAMP: 0.48,
      FLICK_VELOCITY: -0.45,
      OPEN_EXTRA_PX: 8,
      MIN_OPEN_PX: 88
    },
    contentSelector: ".weight-row-content",
    deleteButtonSelector: ".weight-pill-btn.delete",
    getDeleteId(row) {
      return row.getAttribute("data-weight-id");
    },
    getOpenRow() {
      return openRow;
    },
    onDelete() {
      throw new Error("Partial swipe should not trigger delete.");
    },
    setOpenRow(row) {
      openRow = row;
    }
  });

  fixture.content.dispatch("touchstart", createTouchEvent({ x: 180, y: 10 }));
  fixture.content.dispatch("touchmove", createTouchEvent({ x: 90, y: 12 }));
  fixture.content.dispatch("touchend", {});

  assert.equal(openRow, fixture.row);
  assert.equal(fixture.row.classList.contains("is-open"), true);
  assert.match(fixture.content.style.transform, /^translate3d\(-/);

  dom.restore();
});

test("meal swipe rows trigger destructive swipe callback", async () => {
  const dom = installDomGlobals({ innerWidth: 200 });
  const fixture = createSwipeRowFixture({
    actionsSelector: ".meal-pill-actions",
    attributes: { "data-meal-id": "meal-42" },
    buttonSelector: ".meal-pill-btn",
    contentSelector: ".meal-row-content",
    deleteSelector: ".meal-pill-btn.delete",
    includeClone: true
  });

  dom.setComputedStyle(fixture.actions, { columnGap: "8px", gap: "8px", right: "0px" });
  dom.setComputedStyle(fixture.content, { transitionDuration: "0.2s", transitionDelay: "0s" });
  for (let i = 0; i < fixture.buttons.length; i += 1) {
    dom.setComputedStyle(fixture.buttons[i], { width: "48px" });
  }

  let deletedId = "";
  let openRow = null;
  initSwipeRow(fixture.row, {
    actionsSelector: ".meal-pill-actions",
    buttonSelector: ".meal-pill-btn",
    config: {
      SNAP_PX: 52,
      FULL_FRAC: 0.72,
      DAMP: 0.48,
      FLICK_VELOCITY: -0.45,
      OPEN_EXTRA_PX: 8,
      MIN_OPEN_PX: 150
    },
    contentSelector: ".meal-row-content",
    deleteButtonSelector: ".meal-pill-btn.delete",
    getDeleteId(row) {
      return row.getAttribute("data-meal-id");
    },
    getOpenRow() {
      return openRow;
    },
    onDelete(mealId) {
      deletedId = mealId;
    },
    revealThresholdStep: 0.12,
    setOpenRow(row) {
      openRow = row;
    }
  });

  fixture.content.dispatch("touchstart", createTouchEvent({ x: 190, y: 12 }));
  fixture.content.dispatch("touchmove", createTouchEvent({ x: -60, y: 10 }));
  fixture.content.dispatch("touchend", {});

  assert.equal(deletedId, "meal-42");
  assert.equal(openRow, null);
  assert.equal(fixture.row.classList.contains("is-open"), false);

  dom.restore();
});
