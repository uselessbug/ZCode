import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WEB_NOTIFICATION_DEDUPE_WINDOW_MS,
  consumeNotificationDeepLink,
  createWebNotificationController,
  type WebNotificationHost,
} from "../src/platform/webNotifications.js";

const VAPID_KEY = Buffer.alloc(65, 7).toString("base64url");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type Listener = (event: unknown) => void;

class FakeEmitter {
  private listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(event);
  }
}

interface Env {
  log: string[];
  host: WebNotificationHost;
  fetchCalls: Array<{ path: string; init?: RequestInit; body?: any }>;
  shown: Array<{ title: string; options: any }>;
  legacyNotifications: Array<{
    title: string;
    options: any;
    onclick?: () => void;
    closed: boolean;
  }>;
  subscribeCalls: any[];
  subscription: { endpoint: string; unsubscribed: boolean } | null;
  sw: FakeEmitter;
  setPermission(value: NotificationPermission): void;
  registerCalls: Array<{ url: string; options: any }>;
  windowEvents: FakeEmitter;
  setFocused(value: boolean): void;
  documentEvents: FakeEmitter;
  displayed: Array<{ tag: string; data?: any; closed: boolean }>;
  setFetchFailing(path: string, failing: boolean): void;
}

function createEnv(
  options: {
    permission?: NotificationPermission | "absent";
    nextPermission?: NotificationPermission;
    serviceWorker?: boolean;
    pushEnabled?: boolean;
    existingSubscription?: boolean;
    ua?: string;
    standalone?: boolean;
    search?: string;
  } = {},
): Env {
  const log: string[] = [];
  const fetchCalls: Env["fetchCalls"] = [];
  const shown: Env["shown"] = [];
  const legacyNotifications: Env["legacyNotifications"] = [];
  const subscribeCalls: any[] = [];
  const registerCalls: Env["registerCalls"] = [];
  const failing = new Set<string>();
  const sw = new FakeEmitter();
  const windowEvents = new FakeEmitter();
  const documentEvents = new FakeEmitter();
  let focused = false;
  const displayed: Env["displayed"] = [];
  let permission: NotificationPermission =
    options.permission === "absent" ? "default" : (options.permission ?? "default");
  const env = {
    subscription: options.existingSubscription
      ? { endpoint: "https://push.example/existing", unsubscribed: false }
      : null,
  } as Pick<Env, "subscription">;

  class FakeNotification {
    static get permission() {
      return permission;
    }
    static requestPermission(callback?: (value: NotificationPermission) => void) {
      log.push("requestPermission");
      permission = options.nextPermission ?? "granted";
      callback?.(permission);
      return Promise.resolve(permission);
    }
    onclick?: () => void;
    closed = false;
    constructor(
      public title: string,
      public options: any,
    ) {
      legacyNotifications.push(this as any);
    }
    close() {
      this.closed = true;
    }
  }

  const makeSubscription = () => {
    const current = env.subscription!;
    return {
      endpoint: current.endpoint,
      toJSON: () => ({
        endpoint: current.endpoint,
        expirationTime: null,
        keys: { p256dh: "p256", auth: "auth" },
      }),
      unsubscribe: async () => {
        log.push("sub.unsubscribe");
        current.unsubscribed = true;
        env.subscription = null;
        return true;
      },
    };
  };

  const registration = {
    active: {},
    showNotification: async (title: string, notificationOptions: any) => {
      shown.push({ title, options: notificationOptions });
    },
    getNotifications: async () =>
      displayed
        .filter((item) => !item.closed)
        .map((item) => ({
          tag: item.tag,
          data: item.data,
          close: () => {
            item.closed = true;
          },
        })),
    pushManager: {
      getSubscription: async () => (env.subscription ? makeSubscription() : null),
      subscribe: async (subscribeOptions: any) => {
        log.push("pushManager.subscribe");
        subscribeCalls.push(subscribeOptions);
        env.subscription = { endpoint: "https://push.example/new", unsubscribed: false };
        return makeSubscription();
      },
    },
  };
  let registered = Boolean(options.existingSubscription);
  const serviceWorker = Object.assign(sw, {
    register: async (url: string, registerOptions: any) => {
      log.push("sw.register");
      registerCalls.push({ url, options: registerOptions });
      registered = true;
      return registration;
    },
    get ready() {
      return Promise.resolve(registration);
    },
    getRegistration: async () => (registered ? registration : undefined),
  });

  const fetchImpl = async (input: string, init?: RequestInit) => {
    const call: Env["fetchCalls"][number] = { path: input, init };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body);
    fetchCalls.push(call);
    log.push(`fetch ${input}`);
    if (failing.has(input)) return new Response("fail", { status: 500 });
    if (input === "/api/web-push/config") {
      return Response.json({
        enabled: options.pushEnabled ?? true,
        vapidPublicKey: options.pushEnabled === false ? null : VAPID_KEY,
      });
    }
    return Response.json({ ok: true });
  };

  const url = new URL(`https://zcode.example/${options.search ?? ""}`);
  const history = {
    state: null as unknown,
    replaceCalls: [] as string[],
    replaceState(_state: unknown, _unused: string, target?: string | URL | null) {
      history.replaceCalls.push(String(target));
    },
  };

  const navigator: Record<string, unknown> = {
    userAgent: options.ua ?? "Mozilla/5.0 (X11; Linux) Chrome/130",
    platform: "Linux",
    maxTouchPoints: 0,
    permissions: undefined,
  };
  if (options.serviceWorker !== false) navigator.serviceWorker = serviceWorker;

  const host: Record<string, unknown> = {
    navigator,
    location: { search: url.search, pathname: url.pathname, hash: url.hash },
    history,
    document: {
      hasFocus: () => focused,
      visibilityState: "visible",
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
      documentElement: {},
    },
    matchMedia: () => ({ matches: options.standalone === true }),
    fetch: fetchImpl,
    focus: () => log.push("window.focus"),
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
  };
  if (options.permission !== "absent") host.Notification = FakeNotification;
  if (options.serviceWorker !== false) host.PushManager = class {};

  return {
    log,
    host: host as unknown as WebNotificationHost,
    fetchCalls,
    shown,
    legacyNotifications,
    subscribeCalls,
    get subscription() {
      return env.subscription;
    },
    sw,
    registerCalls,
    windowEvents,
    documentEvents,
    displayed,
    setPermission: (value) => {
      permission = value;
    },
    setFocused: (value) => {
      focused = value;
    },
    setFetchFailing: (path, value) => {
      if (value) failing.add(path);
      else failing.delete(path);
    },
  } as Env;
}

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1";

describe("permission state", () => {
  it("reports default, granted and denied from Notification.permission", async () => {
    for (const permission of ["default", "granted", "denied"] as const) {
      const env = createEnv({ permission });
      const controller = createWebNotificationController({
        pushEnabled: true,
        host: env.host,
        reconcileOnStart: false,
      });
      const state = await controller.getWebNotificationState();
      assert.equal(state.permission, permission);
      assert.equal(state.pushSupported, true);
    }
  });

  it("requests permission and registers the push worker once granted", async () => {
    const env = createEnv({ permission: "default" });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    const states: string[] = [];
    controller.onWebNotificationStateChanged((state) => states.push(state.permission));
    const state = await controller.requestWebNotificationPermission();
    assert.equal(state.permission, "granted");
    assert.deepEqual(env.registerCalls, [{ url: "/zcode-push-sw.js", options: { scope: "/" } }]);
    assert.equal(states.at(-1), "granted");
  });

  it("does not request permission again when it is already denied", async () => {
    const env = createEnv({ permission: "denied" });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    const state = await controller.requestWebNotificationPermission();
    assert.equal(state.permission, "denied");
    assert.ok(!env.log.includes("requestPermission"));
  });

  it("asks iOS Safari tabs to install the app first", async () => {
    const env = createEnv({ permission: "absent", ua: IOS_UA, standalone: false });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    assert.equal((await controller.getWebNotificationState()).permission, "ios-install-required");
  });

  it("reports unsupported when there is no Notification API outside iOS browsers", async () => {
    const desktop = createEnv({ permission: "absent" });
    assert.equal(
      (
        await createWebNotificationController({
          pushEnabled: true,
          host: desktop.host,
          reconcileOnStart: false,
        }).getWebNotificationState()
      ).permission,
      "unsupported",
    );
    const installedIos = createEnv({ permission: "absent", ua: IOS_UA, standalone: true });
    assert.equal(
      (
        await createWebNotificationController({
          pushEnabled: true,
          host: installedIos.host,
          reconcileOnStart: false,
        }).getWebNotificationState()
      ).permission,
      "unsupported",
    );
  });

  it("marks push unsupported when the server reports it disabled or remote control is active", async () => {
    const disabled = createEnv({ permission: "granted", pushEnabled: false });
    const a = await createWebNotificationController({
      pushEnabled: true,
      host: disabled.host,
      reconcileOnStart: false,
    }).getWebNotificationState();
    assert.equal(a.pushSupported, false);

    const remote = createEnv({ permission: "granted" });
    const b = await createWebNotificationController({
      pushEnabled: false,
      host: remote.host,
      reconcileOnStart: false,
    }).getWebNotificationState();
    assert.equal(b.pushSupported, false);
    assert.equal(b.pushAvailable, false);
    assert.equal(a.pushAvailable, true);
    assert.equal(remote.fetchCalls.length, 0);
  });

  it("re-reads the state when the window regains focus", async () => {
    const env = createEnv({ permission: "default" });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    const seen: string[] = [];
    const dispose = controller.onWebNotificationStateChanged((state) =>
      seen.push(state.permission),
    );
    env.setPermission("granted");
    env.windowEvents.emit("focus");
    await flush();
    assert.deepEqual(seen, ["granted"]);
    dispose();
    env.setPermission("denied");
    env.windowEvents.emit("focus");
    await flush();
    assert.deepEqual(seen, ["granted"]);
  });
});

describe("web push subscription", () => {
  it("asks for permission first, then subscribes and reports the subscription", async () => {
    const env = createEnv({ permission: "default" });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    const state = await controller.setWebPushSubscribed(true, { locale: "en-US" });

    assert.deepEqual(
      env.log.filter((entry) =>
        ["requestPermission", "sw.register", "pushManager.subscribe"].includes(entry),
      ),
      ["requestPermission", "sw.register", "pushManager.subscribe"],
    );
    assert.ok(
      env.log.indexOf("fetch /api/web-push/config") < env.log.indexOf("pushManager.subscribe"),
    );
    assert.equal(env.subscribeCalls[0].userVisibleOnly, true);
    assert.ok(env.subscribeCalls[0].applicationServerKey instanceof Uint8Array);
    assert.equal(env.subscribeCalls[0].applicationServerKey.length, 65);

    const post = env.fetchCalls.find((call) => call.path === "/api/web-push/subscriptions");
    assert.equal(post?.init?.method, "POST");
    assert.equal(post?.init?.credentials, "same-origin");
    assert.equal(post?.body.locale, "en-US");
    assert.equal(post?.body.subscription.endpoint, "https://push.example/new");
    assert.equal(post?.body.userAgent, env.host.navigator.userAgent);

    assert.equal(state.permission, "granted");
    assert.equal(state.pushSubscribed, true);
    assert.equal(state.busy, false);
    assert.equal(state.error, null);
  });

  it("maps zh locales to zh-CN", async () => {
    const env = createEnv({ permission: "granted" });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    await controller.setWebPushSubscribed(true, { locale: "zh-CN" });
    const post = env.fetchCalls.find((call) => call.path === "/api/web-push/subscriptions");
    assert.equal(post?.body.locale, "zh-CN");
  });

  it("stops without subscribing when permission is not granted", async () => {
    const env = createEnv({ permission: "default", nextPermission: "denied" });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    const state = await controller.setWebPushSubscribed(true, { locale: "zh-CN" });
    assert.equal(state.permission, "denied");
    assert.equal(state.pushSubscribed, false);
    assert.equal(env.subscribeCalls.length, 0);
  });

  it("rolls back the local subscription when the server rejects it", async () => {
    const env = createEnv({ permission: "granted" });
    env.setFetchFailing("/api/web-push/subscriptions", true);
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    const state = await controller.setWebPushSubscribed(true, { locale: "zh-CN" });
    assert.equal(state.pushSubscribed, false);
    assert.equal(state.error, "server_unavailable");
    assert.equal(env.subscription, null);
  });

  it("unsubscribes on the server, then locally", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    assert.equal((await controller.getWebNotificationState()).pushSubscribed, true);
    const state = await controller.setWebPushSubscribed(false);
    const post = env.fetchCalls.find(
      (call) => call.path === "/api/web-push/subscriptions/unsubscribe",
    );
    assert.deepEqual(post?.body, { endpoint: "https://push.example/existing" });
    assert.ok(
      env.log.indexOf("fetch /api/web-push/subscriptions/unsubscribe") <
        env.log.indexOf("sub.unsubscribe"),
    );
    assert.equal(state.pushSubscribed, false);
  });

  it("still unsubscribes locally when the server call fails", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    env.setFetchFailing("/api/web-push/subscriptions/unsubscribe", true);
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    const state = await controller.setWebPushSubscribed(false);
    assert.ok(env.log.includes("sub.unsubscribe"));
    assert.equal(state.pushSubscribed, false);
    assert.equal(state.error, null);
  });

  it("reconciles an existing subscription with the server on startup", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    createWebNotificationController({ pushEnabled: true, host: env.host });
    await flush();
    await flush();
    const posts = env.fetchCalls.filter((call) => call.path === "/api/web-push/subscriptions");
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.body.subscription.endpoint, "https://push.example/existing");
  });

  it("does not touch the server on startup without permission", async () => {
    const env = createEnv({ permission: "default", existingSubscription: true });
    createWebNotificationController({ pushEnabled: true, host: env.host });
    await flush();
    assert.equal(env.fetchCalls.length, 0);
  });
});

describe("task notification master switch and sound", () => {
  it("reports soundEnabled with the subscription and keeps it in sync", async () => {
    const env = createEnv({ permission: "granted" });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
      isSoundEnabled: () => false,
    });
    await controller.setWebPushSubscribed(true, { locale: "zh-CN" });
    const posts = () =>
      env.fetchCalls.filter((call) => call.path === "/api/web-push/subscriptions");
    assert.equal(posts()[0]?.body.soundEnabled, false);

    const state = await controller.setWebPushSubscribed(true, {
      locale: "zh-CN",
      soundEnabled: true,
    });
    assert.equal(posts().length, 2);
    assert.equal(posts()[1]?.body.soundEnabled, true);
    assert.equal(env.subscribeCalls.length, 1);
    assert.equal(state.busy, false);
    assert.equal(state.pushSubscribed, true);
  });

  it("reports the current sound preference when reconciling on startup", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      isEnabled: () => true,
      isSoundEnabled: () => false,
    });
    await flush();
    await flush();
    const posts = env.fetchCalls.filter((call) => call.path === "/api/web-push/subscriptions");
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.body.soundEnabled, false);
  });

  it("drops leftover subscriptions instead of reporting them when disabled", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      isEnabled: () => false,
    });
    await flush();
    await flush();
    assert.equal(
      env.fetchCalls.filter((call) => call.path === "/api/web-push/subscriptions").length,
      0,
    );
    const unsub = env.fetchCalls.find(
      (call) => call.path === "/api/web-push/subscriptions/unsubscribe",
    );
    assert.deepEqual(unsub?.body, { endpoint: "https://push.example/existing" });
    assert.equal(env.subscription, null);
  });

  it("does not subscribe or show notifications while disabled", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
      isEnabled: () => false,
    });
    await controller.setWebPushSubscribed(true, { locale: "en-US" });
    assert.equal(env.subscribeCalls.length, 0);
    assert.equal(
      env.fetchCalls.filter((call) => call.path === "/api/web-push/subscriptions").length,
      0,
    );
    controller.showTaskNotification({
      taskId: "t",
      status: "completed",
      title: "Done",
      body: "x",
    });
    await flush();
    assert.equal(env.shown.length, 0);
  });
});

describe("error codes", () => {
  it("maps failures to shared error codes without leaking raw messages", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const unsupported = createEnv({ permission: "granted", pushEnabled: false });
      const a = await createWebNotificationController({
        pushEnabled: true,
        host: unsupported.host,
        reconcileOnStart: false,
      }).setWebPushSubscribed(true, { locale: "en-US" });
      assert.equal(a.error, "push_unsupported");

      const down = createEnv({ permission: "granted" });
      down.setFetchFailing("/api/web-push/config", true);
      const b = await createWebNotificationController({
        pushEnabled: true,
        host: down.host,
        reconcileOnStart: false,
      }).setWebPushSubscribed(true, { locale: "en-US" });
      assert.equal(b.error, "server_unavailable");

      const denied = createEnv({ permission: "granted" });
      const registration = await (
        denied.host.navigator.serviceWorker as unknown as {
          register(url: string, options: unknown): Promise<any>;
        }
      ).register("/zcode-push-sw.js", { scope: "/" });
      registration.pushManager.subscribe = async () => {
        throw Object.assign(new Error("Registration failed - permission denied"), {
          name: "NotAllowedError",
        });
      };
      const c = await createWebNotificationController({
        pushEnabled: true,
        host: denied.host,
        reconcileOnStart: false,
      }).setWebPushSubscribed(true, { locale: "en-US" });
      assert.equal(c.error, "permission_denied");

      const broken = createEnv({ permission: "granted" });
      const brokenRegistration = await (
        broken.host.navigator.serviceWorker as unknown as {
          register(url: string, options: unknown): Promise<any>;
        }
      ).register("/zcode-push-sw.js", { scope: "/" });
      brokenRegistration.pushManager.subscribe = async () => {
        throw new Error("boom");
      };
      const d = await createWebNotificationController({
        pushEnabled: true,
        host: broken.host,
        reconcileOnStart: false,
      }).setWebPushSubscribed(true, { locale: "en-US" });
      assert.equal(d.error, "subscribe_failed");

      const stuck = createEnv({ permission: "granted", existingSubscription: true });
      const stuckRegistration = await (
        stuck.host.navigator.serviceWorker as unknown as {
          getRegistration(): Promise<any>;
        }
      ).getRegistration();
      stuckRegistration.pushManager.getSubscription = async () => ({
        endpoint: "https://push.example/existing",
        unsubscribe: async () => {
          throw new Error("nope");
        },
      });
      const e = await createWebNotificationController({
        pushEnabled: true,
        host: stuck.host,
        reconcileOnStart: false,
      }).setWebPushSubscribed(false);
      assert.equal(e.error, "unsubscribe_failed");
    } finally {
      console.warn = warn;
    }
  });
});

describe("in-page task notifications", () => {
  const payload = {
    taskId: "task-1",
    status: "completed" as const,
    title: "Task completed",
    body: "Task: demo",
  };

  it("prefers the service worker registration and stays silent", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    let sounds = 0;
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
      playSound: () => void (sounds += 1),
    });
    controller.showTaskNotification(payload);
    await flush();
    assert.equal(env.shown.length, 1);
    assert.equal(env.shown[0]?.title, "Task completed");
    assert.deepEqual(env.shown[0]?.options, {
      body: "Task: demo",
      tag: "zcode:task:task-1:terminal",
      silent: true,
      icon: "/icon-192.png",
      data: { taskId: "task-1" },
    });
    assert.equal(env.legacyNotifications.length, 0);
    assert.equal(sounds, 1);
  });

  it("skips notifications while the page is focused or permission is missing", async () => {
    const focused = createEnv({ permission: "granted", existingSubscription: true });
    focused.setFocused(true);
    createWebNotificationController({
      pushEnabled: true,
      host: focused.host,
      reconcileOnStart: false,
    }).showTaskNotification(payload);
    await flush();
    assert.equal(focused.shown.length, 0);

    const denied = createEnv({ permission: "denied", existingSubscription: true });
    createWebNotificationController({
      pushEnabled: true,
      host: denied.host,
      reconcileOnStart: false,
    }).showTaskNotification(payload);
    await flush();
    assert.equal(denied.shown.length, 0);
  });

  it("dedupes the same tag inside the window and allows it afterwards", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    let clock = 1_000;
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
      now: () => clock,
    });
    controller.showTaskNotification(payload);
    controller.showTaskNotification(payload);
    await flush();
    assert.equal(env.shown.length, 1);

    clock += WEB_NOTIFICATION_DEDUPE_WINDOW_MS - 1;
    controller.showTaskNotification(payload);
    await flush();
    assert.equal(env.shown.length, 1);

    clock += 1;
    controller.showTaskNotification(payload);
    await flush();
    assert.equal(env.shown.length, 2);

    // 不同 tag（交互请求）不受影响。
    controller.showTaskNotification({
      ...payload,
      status: "permission_request",
      requestId: "req-1",
    });
    await flush();
    assert.equal(env.shown.length, 3);
    assert.equal(env.shown[2]?.options.tag, "zcode:interaction:req-1");
  });

  it("suppresses the in-page notification after the service worker showed the push", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    let sounds = 0;
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
      playSound: () => void (sounds += 1),
    });
    env.sw.emit("message", {
      data: { type: "zcode:web-push-shown", tag: "zcode:task:task-1:terminal", eventId: "e1" },
    });
    controller.showTaskNotification(payload);
    await flush();
    assert.equal(env.shown.length, 0);
    assert.equal(sounds, 0);
  });

  it("dedupes both the primary and the secondary tag from the push", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    env.sw.emit("message", {
      data: {
        type: "zcode:web-push-shown",
        tag: "zcode:automation:run-1",
        secondaryTag: "zcode:task:task-1:terminal",
        eventId: "e1",
      },
    });
    controller.showTaskNotification(payload);
    await flush();
    assert.equal(env.shown.length, 0);
  });

  it("closes a pushed notification right away when the page is in the foreground", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    env.setFocused(true);
    env.displayed.push({ tag: "zcode:task:task-1:terminal", closed: false });
    env.displayed.push({ tag: "other", closed: false });
    env.sw.emit("message", {
      data: { type: "zcode:web-push-shown", tag: "zcode:task:task-1:terminal" },
    });
    await flush();
    assert.deepEqual(
      env.displayed.map((item) => item.closed),
      [true, false],
    );
  });

  it("clears stale ZCode notifications when the page regains focus", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    env.displayed.push({ tag: "zcode:interaction:r1", closed: false });
    env.displayed.push({ tag: "unrelated", closed: false });
    env.windowEvents.emit("focus");
    await flush();
    // 页面不在前台时的 focus 事件不清理；真正聚焦后才清理。
    assert.deepEqual(
      env.displayed.map((item) => item.closed),
      [false, false],
    );
    env.setFocused(true);
    env.windowEvents.emit("focus");
    await flush();
    assert.deepEqual(
      env.displayed.map((item) => item.closed),
      [true, false],
    );
  });

  it("closes the other notifications of a task after its notification was clicked", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    env.displayed.push({ tag: "zcode:interaction:r1", data: { taskId: "t-9" }, closed: false });
    env.displayed.push({ tag: "zcode:task:t-2:terminal", data: { taskId: "t-2" }, closed: false });
    env.sw.emit("message", { data: { type: "zcode:notification-click", taskId: "t-9" } });
    await flush();
    assert.deepEqual(
      env.displayed.map((item) => item.closed),
      [true, false],
    );
  });

  it("keeps Web remote control isolated from the root service worker", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    const controller = createWebNotificationController({
      pushEnabled: false,
      host: env.host,
      reconcileOnStart: false,
    });
    const state = await controller.getWebNotificationState();
    assert.equal(state.pushAvailable, false);
    assert.equal(state.pushSupported, false);
    controller.showTaskNotification(payload);
    await flush();
    assert.equal(env.shown.length, 0);
    assert.equal(env.legacyNotifications.length, 1);
    assert.equal(env.registerCalls.length, 0);
    // 远控页不接收 Service Worker 的推送消息。
    env.sw.emit("message", {
      data: { type: "zcode:web-push-shown", tag: "zcode:task:task-9:terminal" },
    });
    controller.showTaskNotification({ ...payload, taskId: "task-9" });
    await flush();
    assert.equal(env.legacyNotifications.length, 2);
  });

  it("falls back to new Notification without a service worker and routes clicks back", async () => {
    const env = createEnv({ permission: "granted", serviceWorker: false });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    const clicks: Array<[string, unknown]> = [];
    controller.onTaskNotificationClick((taskId, context) => clicks.push([taskId, context]));
    controller.showTaskNotification(payload);
    await flush();

    assert.equal(env.legacyNotifications.length, 1);
    const legacy = env.legacyNotifications[0]!;
    assert.deepEqual(legacy.options, {
      body: "Task: demo",
      tag: "zcode:task:task-1:terminal",
      silent: true,
    });
    legacy.onclick?.();
    assert.ok(env.log.includes("window.focus"));
    assert.equal(legacy.closed, true);
    assert.deepEqual(clicks, [["task-1", undefined]]);
  });

  it("falls back to new Notification when showNotification throws", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    const registration = await (
      env.host.navigator.serviceWorker as unknown as {
        getRegistration(): Promise<{ showNotification: () => Promise<void> }>;
      }
    ).getRegistration();
    registration.showNotification = async () => {
      throw new TypeError("Illegal constructor");
    };
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    controller.showTaskNotification(payload);
    await flush();
    assert.equal(env.legacyNotifications.length, 1);
  });
});

describe("notification click routing", () => {
  it("delivers service worker click messages with workspace context", () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    const clicks: unknown[] = [];
    controller.onTaskNotificationClick((taskId, context) => clicks.push({ taskId, context }));
    env.sw.emit("message", {
      data: {
        type: "zcode:notification-click",
        taskId: "t-9",
        workspacePath: "/repo",
        workspaceIdentity: "ssh:box",
      },
    });
    assert.deepEqual(clicks, [
      { taskId: "t-9", context: { workspacePath: "/repo", workspaceIdentity: "ssh:box" } },
    ]);
  });

  it("buffers clicks until a handler is registered", () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    env.sw.emit("message", { data: { type: "zcode:notification-click", taskId: "early" } });
    const clicks: string[] = [];
    controller.onTaskNotificationClick((taskId) => clicks.push(taskId));
    assert.deepEqual(clicks, ["early"]);
  });

  it("ignores malformed messages", () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    const clicks: string[] = [];
    controller.onTaskNotificationClick((taskId) => clicks.push(taskId));
    env.sw.emit("message", { data: null });
    env.sw.emit("message", { data: { type: "zcode:notification-click" } });
    env.sw.emit("message", { data: { type: "other", taskId: "x" } });
    assert.deepEqual(clicks, []);
  });
});

describe("cold start deep link", () => {
  it("extracts the task, strips only the zcode params and keeps the rest", () => {
    const env = createEnv({
      search: "?token=abc&zcodeTask=task%2F1&zcodeWorkspace=%2Fhome%2Fme%2Fproj&remote=r1#frag",
    });
    const target = consumeNotificationDeepLink(env.host);
    assert.deepEqual(target, { taskId: "task/1", workspacePath: "/home/me/proj" });
    assert.deepEqual((env.host.history as unknown as { replaceCalls: string[] }).replaceCalls, [
      "/?token=abc&remote=r1#frag",
    ]);
  });

  it("extracts and strips the workspace identity too", () => {
    const env = createEnv({
      search: "?zcodeTask=t1&zcodeWorkspace=%2Frepo&zcodeWorkspaceIdentity=id%3A1&token=abc",
    });
    assert.deepEqual(consumeNotificationDeepLink(env.host), {
      taskId: "t1",
      workspacePath: "/repo",
      workspaceIdentity: "id:1",
    });
    assert.deepEqual((env.host.history as unknown as { replaceCalls: string[] }).replaceCalls, [
      "/?token=abc",
    ]);
  });

  it("works without a workspace and leaves unrelated URLs untouched", () => {
    const only = createEnv({ search: "?zcodeTask=t1" });
    assert.deepEqual(consumeNotificationDeepLink(only.host), { taskId: "t1" });
    assert.deepEqual((only.host.history as unknown as { replaceCalls: string[] }).replaceCalls, [
      "/",
    ]);

    const none = createEnv({ search: "?remote=r1" });
    assert.equal(consumeNotificationDeepLink(none.host), null);
    assert.deepEqual((none.host.history as unknown as { replaceCalls: string[] }).replaceCalls, []);
  });

  it("hands the cold start target to the first click handler", () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
      initialTarget: { taskId: "cold", workspacePath: "/repo" },
    });
    const clicks: unknown[] = [];
    controller.onTaskNotificationClick((taskId, context) => clicks.push({ taskId, context }));
    controller.notifyRendererReady();
    assert.deepEqual(clicks, [{ taskId: "cold", context: { workspacePath: "/repo" } }]);
  });
});

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("push service worker script", () => {
  const scriptPath = new URL("../public/zcode-push-sw.js", import.meta.url);

  async function loadWorker(
    windowClients: Array<Record<string, unknown>>,
    userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
  ) {
    const { readFile } = await import("node:fs/promises");
    const vm = await import("node:vm");
    const handlers = new Map<string, (event: any) => void>();
    const calls = {
      shown: [] as Array<{ title: string; options: any }>,
      closed: [] as string[],
      opened: [] as string[],
      skipWaiting: 0,
      claimed: 0,
    };
    const self = {
      location: { origin: "https://zcode.example" },
      navigator: { userAgent },
      addEventListener: (type: string, handler: (event: any) => void) =>
        handlers.set(type, handler),
      skipWaiting: () => void (calls.skipWaiting += 1),
      clients: {
        claim: async () => void (calls.claimed += 1),
        matchAll: async () => windowClients,
        openWindow: async (url: string) => void calls.opened.push(url),
      },
      registration: {
        showNotification: async (title: string, options: any) => {
          calls.shown.push({ title, options });
        },
        getNotifications: async ({ tag }: { tag: string }) => [
          { close: () => calls.closed.push(tag) },
        ],
      },
    };
    // vm 内创建的对象原型属于另一个 realm，断言前统一转成普通 JSON。
    vm.runInNewContext(await readFile(scriptPath, "utf8"), { self, URL, console });
    const dispatch = async (type: string, event: Record<string, unknown>) => {
      const waits: Promise<unknown>[] = [];
      handlers.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    };
    return { calls, dispatch };
  }

  const pushEvent = (payload: unknown) => ({ data: { json: () => payload } });
  const showPayload = {
    version: 1,
    action: "show",
    eventId: "e1",
    tag: "zcode:task:t1:terminal",
    title: "Task completed",
    body: "Task: demo",
    taskId: "t1",
    workspacePath: "/repo",
    workspaceIdentity: "id-1",
  };

  it("takes over immediately without handling fetch", async () => {
    const { calls, dispatch } = await loadWorker([]);
    await dispatch("install", {});
    await dispatch("activate", {});
    assert.equal(calls.skipWaiting, 1);
    assert.equal(calls.claimed, 1);
  });

  it("shows a notification and tells background tabs", async () => {
    const posted: unknown[] = [];
    const tab = {
      url: "https://zcode.example/",
      focused: false,
      postMessage: (message: unknown) => posted.push(message),
    };
    const { calls, dispatch } = await loadWorker([tab]);
    await dispatch("push", pushEvent(showPayload));
    assert.equal(calls.shown.length, 1);
    assert.deepEqual(plain(calls.shown[0]?.options), {
      body: "Task: demo",
      tag: "zcode:task:t1:terminal",
      icon: "/icon-192.png",
      silent: false,
      renotify: false,
      data: {
        taskId: "t1",
        workspacePath: "/repo",
        workspaceIdentity: "id-1",
        tag: "zcode:task:t1:terminal",
      },
    });
    assert.deepEqual(plain(posted), [
      { type: "zcode:web-push-shown", tag: "zcode:task:t1:terminal", eventId: "e1" },
    ]);
  });

  it("broadcasts the secondary tag and honours silent", async () => {
    const posted: unknown[] = [];
    const { calls, dispatch } = await loadWorker([
      {
        url: "https://zcode.example/",
        focused: false,
        postMessage: (m: unknown) => posted.push(m),
      },
    ]);
    await dispatch(
      "push",
      pushEvent({
        ...showPayload,
        tag: "zcode:automation:run-1",
        secondaryTag: "zcode:task:t1:terminal",
        silent: true,
      }),
    );
    assert.equal(calls.shown[0]?.options.silent, true);
    assert.equal("badge" in calls.shown[0]!.options, false);
    assert.deepEqual(plain(posted), [
      {
        type: "zcode:web-push-shown",
        tag: "zcode:automation:run-1",
        secondaryTag: "zcode:task:t1:terminal",
        eventId: "e1",
      },
    ]);
  });

  it("skips the notification only for a visible focused workbench on non-Apple browsers", async () => {
    const focusedWorkbench = {
      url: "https://zcode.example/",
      focused: true,
      visibilityState: "visible",
      postMessage: () => {},
    };
    const chrome = await loadWorker([focusedWorkbench]);
    await chrome.dispatch("push", pushEvent(showPayload));
    assert.equal(chrome.calls.shown.length, 0);

    // 聚焦但不可见、可见但未聚焦、以及非工作台页面都不豁免。
    for (const client of [
      { ...focusedWorkbench, visibilityState: "hidden" },
      { ...focusedWorkbench, focused: false },
      { ...focusedWorkbench, url: "https://zcode.example/remote/v4" },
      { ...focusedWorkbench, url: "https://zcode.example/share/abc" },
      { ...focusedWorkbench, url: "https://zcode.example/cn/share/abc" },
      { ...focusedWorkbench, url: "https://evil.example/" },
    ]) {
      const worker = await loadWorker([client]);
      await worker.dispatch("push", pushEvent(showPayload));
      assert.equal(worker.calls.shown.length, 1, client.url + client.visibilityState);
    }
  });

  it("always shows on iOS and Mac Safari, even with a focused workbench", async () => {
    const focusedWorkbench = {
      url: "https://zcode.example/index.html",
      focused: true,
      visibilityState: "visible",
      postMessage: () => {},
    };
    for (const userAgent of [
      IOS_UA,
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15",
    ]) {
      const { calls, dispatch } = await loadWorker([focusedWorkbench], userAgent);
      await dispatch("push", pushEvent(showPayload));
      assert.equal(calls.shown.length, 1);
    }
    // iOS Chrome / Firefox (CriOS / FxiOS) 底层同样是 Apple WebKit，不能跳过展示。
    const crios = await loadWorker(
      [focusedWorkbench],
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 CriOS/124 Mobile/15E148 Safari/604.1",
    );
    await crios.dispatch("push", pushEvent(showPayload));
    assert.equal(crios.calls.shown.length, 1);

    // Android Chrome 属于真 Chromium，工作台在前台时允许跳过展示。
    const androidChrome = await loadWorker(
      [focusedWorkbench],
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    );
    await androidChrome.dispatch("push", pushEvent(showPayload));
    assert.equal(androidChrome.calls.shown.length, 0);
  });

  it("never returns silently: broken payloads fall back to a generic notification", async () => {
    for (const event of [
      { data: null },
      {
        data: {
          json: () => {
            throw new SyntaxError("bad json");
          },
        },
      },
      { data: { json: () => null } },
      { data: { json: () => ({ action: "show" }) } },
      { data: { json: () => ({ action: "dismiss", tag: "zcode:task:t1:terminal" }) } },
    ]) {
      const { calls, dispatch } = await loadWorker([]);
      await dispatch("push", event);
      assert.equal(calls.shown.length, 1);
      assert.equal(calls.shown[0]?.title, "ZCode");
      assert.equal(calls.shown[0]?.options.icon, "/icon-192.png");
    }
  });

  it("focuses an open workbench window and passes the target on click", async () => {
    const messages: unknown[] = [];
    let focused = 0;
    const { calls, dispatch } = await loadWorker([
      { url: "https://zcode.example/remote/v4", focus: async () => {}, postMessage: () => {} },
      {
        url: "https://zcode.example/?foo=1",
        focus: async () => void (focused += 1),
        postMessage: (message: unknown) => messages.push(message),
      },
    ]);
    let closed = false;
    await dispatch("notificationclick", {
      notification: {
        close: () => (closed = true),
        data: { taskId: "t1", workspacePath: "/repo", workspaceIdentity: "id-1" },
      },
    });
    assert.equal(closed, true);
    assert.equal(focused, 1);
    assert.deepEqual(plain(messages), [
      {
        type: "zcode:notification-click",
        taskId: "t1",
        workspacePath: "/repo",
        workspaceIdentity: "id-1",
      },
    ]);
    assert.deepEqual(calls.opened, []);
  });

  it("prefers the focused or visible workbench window when several are open", async () => {
    const messages: string[] = [];
    const makeClient = (name: string, extra: Record<string, unknown>) => ({
      url: "https://zcode.example/",
      focus: async () => {},
      postMessage: () => messages.push(name),
      ...extra,
    });
    const { dispatch } = await loadWorker([
      makeClient("background", { visibilityState: "hidden", focused: false }),
      makeClient("visible", { visibilityState: "visible", focused: false }),
      makeClient("focused", { visibilityState: "visible", focused: true }),
    ]);
    await dispatch("notificationclick", {
      notification: { close: () => {}, data: { taskId: "t1" } },
    });
    assert.deepEqual(messages, ["focused"]);
  });

  it("does not hijack remote or share pages and opens a new workbench instead", async () => {
    const { calls, dispatch } = await loadWorker([
      { url: "https://zcode.example/remote/v4", focus: async () => {}, postMessage: () => {} },
      { url: "https://zcode.example/share/abc", focus: async () => {}, postMessage: () => {} },
      { url: "https://zcode.example/cn/share/abc", focus: async () => {}, postMessage: () => {} },
    ]);
    await dispatch("notificationclick", {
      notification: { close: () => {}, data: { taskId: "t1" } },
    });
    assert.deepEqual(calls.opened, ["https://zcode.example/?zcodeTask=t1"]);
  });

  it("opens a deep link when no window is open", async () => {
    const { calls, dispatch } = await loadWorker([]);
    await dispatch("notificationclick", {
      notification: {
        close: () => {},
        data: { taskId: "t 1", workspacePath: "/my repo", workspaceIdentity: "id 1" },
      },
    });
    assert.deepEqual(calls.opened, [
      "https://zcode.example/?zcodeTask=t+1&zcodeWorkspace=%2Fmy+repo&zcodeWorkspaceIdentity=id+1",
    ]);
    await dispatch("notificationclick", { notification: { close: () => {}, data: {} } });
    assert.equal(calls.opened[1], "https://zcode.example/");
  });
});
