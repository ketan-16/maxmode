function makeClassList(initial = []) {
  const values = new Set(initial);

  return {
    add(...tokens) {
      for (let i = 0; i < tokens.length; i += 1) values.add(tokens[i]);
    },
    contains(token) {
      return values.has(token);
    },
    remove(...tokens) {
      for (let i = 0; i < tokens.length; i += 1) values.delete(tokens[i]);
    },
    toggle(token, force) {
      if (force === true) {
        values.add(token);
        return true;
      }
      if (force === false) {
        values.delete(token);
        return false;
      }
      if (values.has(token)) {
        values.delete(token);
        return false;
      }
      values.add(token);
      return true;
    }
  };
}

function makeEventTarget(extra = {}) {
  const listeners = new Map();
  const element = {
    classList: makeClassList(extra.classNames || []),
    dataset: { ...(extra.dataset || {}) },
    disabled: false,
    offsetWidth: extra.offsetWidth || 0,
    style: {},
    textContent: "",
    ...extra
  };

  element.addEventListener = function addEventListener(type, handler) {
    const handlers = listeners.get(type) || [];
    handlers.push(handler);
    listeners.set(type, handlers);
  };

  element.removeEventListener = function removeEventListener(type, handler) {
    const handlers = listeners.get(type) || [];
    listeners.set(type, handlers.filter((item) => item !== handler));
  };

  element.dispatch = function dispatch(type, event = {}) {
    const handlers = listeners.get(type) || [];
    for (let i = 0; i < handlers.length; i += 1) {
      handlers[i](event);
    }
  };

  return element;
}

export function createUiElement(extra = {}) {
  return makeEventTarget(extra);
}

export function createSwipeRowFixture(options = {}) {
  const actions = makeEventTarget();
  const content = makeEventTarget();
  const editButton = makeEventTarget({ offsetWidth: 48 });
  const deleteButton = makeEventTarget({ classNames: ["delete"], offsetWidth: 48 });
  const cloneButton = makeEventTarget({ offsetWidth: 48 });
  const buttons = options.includeClone ? [editButton, cloneButton, deleteButton] : [editButton, deleteButton];
  const attributes = {
    ...(options.attributes || {})
  };

  actions.querySelectorAll = (selector) => selector === (options.buttonSelector || ".btn") ? buttons : [];

  const row = makeEventTarget({
    dataset: {},
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    querySelector(selector) {
      if (selector === options.contentSelector) return content;
      if (selector === options.actionsSelector) return actions;
      if (selector === options.deleteSelector) return deleteButton;
      return null;
    }
  });

  return {
    actions,
    buttons,
    content,
    deleteButton,
    row
  };
}

export function createTouchEvent({ x, y, cancelable = true } = {}) {
  let defaultPrevented = false;
  return {
    cancelable,
    preventDefault() {
      defaultPrevented = true;
    },
    touches: [{ clientX: x, clientY: y }],
    get defaultPrevented() {
      return defaultPrevented;
    }
  };
}

export function installDomGlobals(options = {}) {
  const originalWindow = globalThis.window;
  const originalNavigator = globalThis.navigator;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

  const computedStyles = new Map();
  const windowObject = {
    cancelAnimationFrame() {},
    clearTimeout,
    getComputedStyle(element) {
      return computedStyles.get(element) || {
        columnGap: "8px",
        gap: "8px",
        right: "0px",
        transitionDelay: "0s",
        transitionDuration: "0s",
        width: String(element && element.offsetWidth ? element.offsetWidth : 0)
      };
    },
    innerWidth: options.innerWidth || 200,
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    setTimeout
  };

  const navigatorObject = {
    vibrate: options.vibrate || (() => {})
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowObject,
    writable: true
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: navigatorObject,
    writable: true
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: windowObject.requestAnimationFrame,
    writable: true
  });

  return {
    setComputedStyle(element, style) {
      computedStyles.set(element, {
        columnGap: "8px",
        gap: "8px",
        right: "0px",
        transitionDelay: "0s",
        transitionDuration: "0s",
        width: String(element && element.offsetWidth ? element.offsetWidth : 0),
        ...style
      });
    },
    restore() {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
        writable: true
      });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: originalNavigator,
        writable: true
      });
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: originalRequestAnimationFrame,
        writable: true
      });
    }
  };
}
