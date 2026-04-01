export function createBodyScrollLock(options = {}) {
  const isMobileUi = (typeof options.isMobileUi === "function")
    ? options.isMobileUi
    : (() => false);

  let scrollLocked = false;
  let scrollY = 0;
  let unlockTimer = null;
  let viewportCleanup = null;

  function clearPendingUnlock() {
    if (unlockTimer !== null) {
      window.clearTimeout(unlockTimer);
      unlockTimer = null;
    }

    if (typeof viewportCleanup === "function") {
      const cleanup = viewportCleanup;
      viewportCleanup = null;
      cleanup();
    }
  }

  function lock() {
    clearPendingUnlock();
    if (scrollLocked || !document.body) return;

    scrollY = window.scrollY || window.pageYOffset || 0;
    document.body.classList.add("modal-scroll-locked");
    document.body.style.top = `-${scrollY}px`;
    scrollLocked = true;
  }

  function unlockNow() {
    clearPendingUnlock();
    if (!scrollLocked || !document.body) return;

    const restoreY = scrollY;
    document.body.classList.remove("modal-scroll-locked");
    document.body.style.top = "";
    window.scrollTo(0, restoreY);
    requestAnimationFrame(() => {
      window.scrollTo(0, restoreY);
    });

    scrollLocked = false;
  }

  function unlockAfterKeyboard() {
    clearPendingUnlock();
    if (!scrollLocked) return;

    if (window.visualViewport && isMobileUi()) {
      const viewport = window.visualViewport;
      const deadlineTs = Date.now() + 420;

      function finalizeUnlock() {
        unlockNow();
      }

      function queueUnlock() {
        if (unlockTimer !== null) {
          window.clearTimeout(unlockTimer);
        }

        const msLeft = deadlineTs - Date.now();
        const delay = msLeft <= 0 ? 0 : Math.min(120, msLeft);
        unlockTimer = window.setTimeout(finalizeUnlock, delay);
      }

      function onViewportChange() {
        queueUnlock();
      }

      viewport.addEventListener("resize", onViewportChange);
      viewport.addEventListener("scroll", onViewportChange);
      viewportCleanup = () => {
        viewport.removeEventListener("resize", onViewportChange);
        viewport.removeEventListener("scroll", onViewportChange);
      };

      queueUnlock();
      return;
    }

    unlockNow();
  }

  return {
    clearPendingUnlock,
    isLocked() {
      return scrollLocked;
    },
    lock,
    unlockAfterKeyboard,
    unlockNow
  };
}
