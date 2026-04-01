import { getMaxTransitionMs } from "./motion-utils.mjs";

function toArray(value) {
  return Array.isArray(value) ? value : Array.from(value || []);
}

export function initSwipeRow(row, options = {}) {
  if (!row || row.dataset.swipeBound === "1") return;
  row.dataset.swipeBound = "1";

  const content = row.querySelector(options.contentSelector || ".swipe-row-content");
  const actions = row.querySelector(options.actionsSelector || ".swipe-row-actions");
  if (!content || !actions) return;

  const config = options.config || {};
  const buttons = toArray(actions.querySelectorAll(options.buttonSelector || "button"));
  const deleteButton = row.querySelector(options.deleteButtonSelector || ".delete");
  const revealThresholdBase = Number.isFinite(options.revealThresholdBase) ? options.revealThresholdBase : 0.08;
  const revealThresholdStep = Number.isFinite(options.revealThresholdStep) ? options.revealThresholdStep : 0.14;
  const minOpenPx = Number.isFinite(config.MIN_OPEN_PX) ? config.MIN_OPEN_PX : 88;
  const openExtraPx = Number.isFinite(config.OPEN_EXTRA_PX) ? config.OPEN_EXTRA_PX : 8;
  const fullFrac = Number.isFinite(config.FULL_FRAC) ? config.FULL_FRAC : 0.72;
  const damp = Number.isFinite(config.DAMP) ? config.DAMP : 0.48;
  const snapPx = Number.isFinite(config.SNAP_PX) ? config.SNAP_PX : 52;
  const flickVelocity = Number.isFinite(config.FLICK_VELOCITY) ? config.FLICK_VELOCITY : -0.45;
  const getOpenRow = (typeof options.getOpenRow === "function") ? options.getOpenRow : (() => null);
  const setOpenRow = (typeof options.setOpenRow === "function") ? options.setOpenRow : (() => {});
  const onDelete = (typeof options.onDelete === "function") ? options.onDelete : (() => {});
  const getDeleteId = (typeof options.getDeleteId === "function")
    ? options.getDeleteId
    : (() => "");

  const openPx = measureOpenPx();
  row._openPx = openPx;

  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let curX = 0;
  let lastMoveX = 0;
  let lastMoveTime = 0;
  let velocityX = 0;
  let dragging = false;
  let locked = false;
  let queuedX = 0;
  let translateFrame = null;
  let willChangeTimer = null;
  let actionsHideTimer = null;

  function measureOpenPx() {
    if (!buttons.length) return 0;

    const actionsStyle = window.getComputedStyle(actions);
    let gap = parseFloat(actionsStyle.columnGap || actionsStyle.gap || "0");
    let rightInset = parseFloat(actionsStyle.right || "0");
    if (!Number.isFinite(gap)) gap = 0;
    if (!Number.isFinite(rightInset)) rightInset = 0;

    let actionWidth = 0;
    for (let i = 0; i < buttons.length; i += 1) {
      let layoutWidth = buttons[i].offsetWidth;
      if (!layoutWidth) {
        const buttonStyle = window.getComputedStyle(buttons[i]);
        layoutWidth = parseFloat(buttonStyle.width || "0");
      }
      actionWidth += layoutWidth;
    }
    actionWidth += Math.max(0, buttons.length - 1) * gap;

    return Math.max(minOpenPx, Math.ceil(actionWidth + rightInset + openExtraPx));
  }

  function clearWillChangeSoon() {
    if (willChangeTimer !== null) {
      window.clearTimeout(willChangeTimer);
    }

    const delay = Math.max(90, Math.round(getMaxTransitionMs(content)));
    willChangeTimer = window.setTimeout(() => {
      willChangeTimer = null;
      if (!dragging) {
        content.style.willChange = "";
      }
    }, delay);
  }

  function clearActionsHideSoon() {
    if (actionsHideTimer !== null) {
      window.clearTimeout(actionsHideTimer);
      actionsHideTimer = null;
    }
  }

  function cancelTranslateFrame() {
    if (translateFrame !== null) {
      window.cancelAnimationFrame(translateFrame);
      translateFrame = null;
    }
  }

  function toggleDeleteExpansion(x) {
    if (!deleteButton) return;
    if (x < -(window.innerWidth * fullFrac)) {
      deleteButton.classList.add("expanding");
    } else {
      deleteButton.classList.remove("expanding");
    }
  }

  function toggleButtons(progress) {
    for (let i = 0; i < buttons.length; i += 1) {
      if (progress > (revealThresholdBase + (i * revealThresholdStep))) {
        buttons[i].classList.add("show");
      } else {
        buttons[i].classList.remove("show");
      }
    }
  }

  function applyTranslate(x, animate) {
    content.style.transition = animate
      ? "transform var(--motion-duration-snap) var(--motion-ease-emphasized)"
      : "none";
    content.style.transform = `translate3d(${x}px, 0, 0)`;

    if (x < -4) {
      actions.classList.add("visible");
      toggleButtons(Math.min(1, Math.abs(x) / Math.max(openPx, 1)));
    } else if (Math.abs(x) < 8) {
      actions.classList.remove("visible");
      toggleButtons(0);
    }
  }

  function scheduleTranslate(x) {
    queuedX = x;
    if (translateFrame !== null) return;

    translateFrame = requestAnimationFrame(() => {
      translateFrame = null;
      applyTranslate(queuedX, false);
      toggleDeleteExpansion(queuedX);
    });
  }

  function flushTranslateFrame() {
    if (translateFrame === null) return;
    window.cancelAnimationFrame(translateFrame);
    translateFrame = null;
    applyTranslate(queuedX, false);
    toggleDeleteExpansion(queuedX);
  }

  function snapTo(x) {
    cancelTranslateFrame();
    clearActionsHideSoon();
    curX = x;
    queuedX = x;
    applyTranslate(x, true);
    toggleDeleteExpansion(x);

    if (x < 0) {
      row.classList.add("is-open");
    } else {
      row.classList.remove("is-open");
    }

    if (x === 0) {
      const delay = Math.max(90, Math.round(getMaxTransitionMs(content)));
      actionsHideTimer = window.setTimeout(() => {
        actionsHideTimer = null;
        actions.classList.remove("visible");
        toggleButtons(0);
      }, delay);
    }

    clearWillChangeSoon();
  }

  function closeRow() {
    snapTo(0);
    if (getOpenRow() === row) {
      setOpenRow(null);
    }
  }

  function onStart(event) {
    if (!event.touches || event.touches.length !== 1) return;

    const openRow = getOpenRow();
    if (openRow && openRow !== row && typeof openRow._close === "function") {
      openRow._close();
      setOpenRow(null);
    }

    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    baseX = curX;
    lastMoveX = startX;
    lastMoveTime = Date.now();
    velocityX = 0;
    dragging = true;
    locked = false;
    cancelTranslateFrame();
    clearActionsHideSoon();
    if (willChangeTimer !== null) {
      window.clearTimeout(willChangeTimer);
      willChangeTimer = null;
    }
    content.style.willChange = "transform";
    content.style.transition = "none";
  }

  function onMove(event) {
    if (!dragging || !event.touches || event.touches.length !== 1) return;

    const x = event.touches[0].clientX;
    const y = event.touches[0].clientY;
    const dx = x - startX;
    const dy = y - startY;

    if (!locked) {
      if (Math.hypot(dx, dy) < 5) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        dragging = false;
        content.style.willChange = "";
        return;
      }
      locked = true;
    }

    if (event.cancelable) event.preventDefault();

    let raw = baseX + dx;
    const now = Date.now();
    const dt = now - lastMoveTime;
    if (dt > 0) {
      velocityX = (x - lastMoveX) / dt;
    }
    lastMoveX = x;
    lastMoveTime = now;

    if (raw > 0) {
      raw *= 0.2;
    }

    if (raw < -openPx) {
      raw = -openPx + ((raw + openPx) * damp);
    }

    curX = raw;
    scheduleTranslate(raw);
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;

    flushTranslateFrame();

    if (deleteButton) {
      deleteButton.classList.remove("expanding");
    }

    if (curX < -(window.innerWidth * fullFrac)) {
      closeRow();
      if (navigator.vibrate) {
        navigator.vibrate(10);
      }
      onDelete(getDeleteId(row));
      return;
    }

    if ((Math.abs(curX) > snapPx || velocityX < flickVelocity) && buttons.length > 0) {
      snapTo(-(row._openPx || openPx));
      setOpenRow(row);
      row._close = closeRow;
    } else {
      closeRow();
    }
  }

  content.addEventListener("touchstart", onStart, { passive: true });
  content.addEventListener("touchmove", onMove, { passive: false });
  content.addEventListener("touchend", onEnd);
  content.addEventListener("touchcancel", onEnd);
  content.addEventListener("click", () => {
    if (getOpenRow() === row) {
      closeRow();
    }
  });

  row._close = closeRow;
}

export function initSwipeRows(list, options = {}) {
  if (!list) return;
  const rowSelector = options.rowSelector || ".swipe-row";
  const rows = list.querySelectorAll(rowSelector);
  for (let i = 0; i < rows.length; i += 1) {
    initSwipeRow(rows[i], options);
  }
}
