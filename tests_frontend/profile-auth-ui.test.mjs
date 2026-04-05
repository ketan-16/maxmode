import test from "node:test";
import assert from "node:assert/strict";

function createLocalStorageMock() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    }
  };
}

if (!globalThis.localStorage) {
  globalThis.localStorage = createLocalStorageMock();
}

const storage = await import("../static/js/modules/storage.mjs");
const profileUi = await import("../static/js/views/profile-ui.mjs");

function createClassList() {
  const classes = new Set();
  return {
    add(token) {
      classes.add(token);
    },
    remove(token) {
      classes.delete(token);
    },
    toggle(token, force) {
      if (force === true) {
        classes.add(token);
        return true;
      }
      if (force === false) {
        classes.delete(token);
        return false;
      }
      if (classes.has(token)) {
        classes.delete(token);
        return false;
      }
      classes.add(token);
      return true;
    },
    contains(token) {
      return classes.has(token);
    }
  };
}

function installProfileDom() {
  const elements = new Map();

  function register(id, extra = {}) {
    const element = {
      id,
      classList: createClassList(),
      dataset: {},
      style: {},
      textContent: "",
      value: "",
      src: "",
      focus() {},
      scrollIntoView() {},
      setAttribute(name, value) {
        this[name] = value;
      },
      getAttribute(name) {
        return this[name] || null;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      ...extra
    };
    elements.set(id, element);
    return element;
  }

  register("nav-avatar");
  register("nav-auth-badge");
  register("profile-name");
  register("profile-avatar");
  register("profile-since");
  register("profile-auth-modal", { classList: createClassList() });
  register("profile-auth-card");
  register("profile-auth-inline");
  register("profile-auth-inline-copy");
  register("profile-auth-guest");
  register("profile-auth-member", { classList: createClassList() });
  register("profile-auth-copy");
  register("profile-auth-badge-copy");
  register("profile-auth-email");
  register("profile-auth-submit");
  register("profile-auth-email-display");
  register("profile-auth-sync-status");
  register("profile-auth-mode", { value: "signup" });
  register("profile-auth-password");
  register("profile-auth-error", { classList: createClassList() });
  register("profile-age-input");
  register("profile-gender-input");
  register("profile-height-cm-input");
  register("profile-height-ft-input");
  register("profile-height-in-input");
  register("profile-height-unit", { value: "cm" });
  register("profile-height-cm-field", { classList: createClassList() });
  register("profile-height-imperial-field", { classList: createClassList() });
  register("profile-pref-height-unit", { value: "cm" });
  register("profile-pref-weight-unit", { value: "kg" });
  register("profile-ai-calculation-mode", { value: "balanced" });
  register("profile-latest-weight");
  register("profile-protein-multiplier-input");
  register("profile-protein-multiplier-unit");
  register("profile-protein-target-input");
  register("profile-protein-status");
  register("profile-activity-level-text");
  register("profile-activity-modal", { classList: createClassList() });
  register("profile-page-root", {
    dataset: {},
    addEventListener() {},
    querySelector() {
      return null;
    }
  });

  const groups = new Map();
  groups.set("profile-auth-mode", {
    getAttribute() {
      return "profile-auth-mode";
    },
    setAttribute() {},
    querySelectorAll() {
      return [
        {
          getAttribute() {
            return "signup";
          },
          classList: createClassList(),
          setAttribute() {}
        },
        {
          getAttribute() {
            return "signin";
          },
          classList: createClassList(),
          setAttribute() {}
        }
      ];
    }
  });

  const originalDocument = globalThis.document;
  globalThis.document = {
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelector(selector) {
      const match = selector.match(/^\[data-profile-segment="(.+)"\]$/);
      if (match) return groups.get(match[1]) || null;
      return null;
    }
  };

  return {
    elements,
    restore() {
      globalThis.document = originalDocument;
    }
  };
}

function resetStorage() {
  globalThis.localStorage.clear();
  storage.invalidateState();
}

test("renderNavAvatar shows the auth badge while signed out", () => {
  resetStorage();
  const dom = installProfileDom();

  try {
    profileUi.renderNavAvatar(null, {
      status: "guest",
      email: "",
      hasServerData: false,
      pendingMutationCount: 0,
      syncStatus: "idle",
      lastSyncAt: "",
      lastSyncError: ""
    });

    assert.equal(dom.elements.get("nav-auth-badge").classList.contains("is-visible"), true);
  } finally {
    dom.restore();
  }
});

test("renderNavAvatar hides the auth badge while authenticated", () => {
  resetStorage();
  const dom = installProfileDom();

  try {
    profileUi.renderNavAvatar(null, {
      status: "authenticated",
      email: "member@example.com",
      hasServerData: true,
      pendingMutationCount: 0,
      syncStatus: "idle",
      lastSyncAt: "",
      lastSyncError: ""
    });

    assert.equal(dom.elements.get("nav-auth-badge").classList.contains("is-visible"), false);
  } finally {
    dom.restore();
  }
});

test("render hides the account card for guests and shows the inline auth prompt", () => {
  resetStorage();
  const dom = installProfileDom();

  try {
    profileUi.render({
      user: null,
      weights: [],
      meals: [],
      auth: {
        status: "guest",
        email: "",
        hasServerData: false,
        pendingMutationCount: 0,
        syncStatus: "idle",
        lastSyncAt: "",
        lastSyncError: "",
        lastError: ""
      }
    });

    assert.equal(dom.elements.get("profile-auth-card").classList.contains("hidden"), true);
    assert.equal(dom.elements.get("profile-auth-inline").classList.contains("hidden"), false);
    assert.equal(dom.elements.get("profile-auth-modal").classList.contains("hidden"), true);
  } finally {
    dom.restore();
  }
});

test("render shows the account card for authenticated users and hides the inline auth prompt", () => {
  resetStorage();
  const dom = installProfileDom();

  try {
    profileUi.render({
      user: null,
      weights: [],
      meals: [],
      auth: {
        status: "authenticated",
        email: "member@example.com",
        hasServerData: true,
        pendingMutationCount: 0,
        syncStatus: "idle",
        lastSyncAt: "",
        lastSyncError: "",
        lastError: ""
      }
    });

    assert.equal(dom.elements.get("profile-auth-card").classList.contains("hidden"), false);
    assert.equal(dom.elements.get("profile-auth-inline").classList.contains("hidden"), true);
    assert.equal(dom.elements.get("profile-auth-modal").classList.contains("hidden"), true);
  } finally {
    dom.restore();
  }
});
