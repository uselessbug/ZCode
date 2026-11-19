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

  it("carries workspacePath and workspaceIdentity in the service worker notification data", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    controller.showTaskNotification({
      ...payload,
      workspacePath: "/workspace/maintenance",
      workspaceIdentity: "id-maint",
    });
    await flush();
    assert.deepEqual(env.shown[0]?.options.data, {
      taskId: "task-1",
      workspacePath: "/workspace/maintenance",
      workspaceIdentity: "id-maint",
    });
  });

  it("passes the workspace through when a fallback Notification is clicked", async () => {
    const env = createEnv({ permission: "granted", serviceWorker: false });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    const clicks: Array<[string, unknown]> = [];
    controller.onTaskNotificationClick((taskId, context) => clicks.push([taskId, context]));
    controller.showTaskNotification({
      ...payload,
      workspacePath: "/workspace/maintenance",
      workspaceIdentity: "id-maint",
    });
    await flush();
    env.legacyNotifications[0]!.onclick?.();
    assert.deepEqual(clicks, [
      ["task-1", { workspacePath: "/workspace/maintenance", workspaceIdentity: "id-maint" }],
    ]);
  });

  it("starts the service worker message queue after registering the listener", () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    const container = env.host.navigator.serviceWorker as unknown as {
      startMessages?: () => void;
    };
    let started = 0;
    container.startMessages = () => void (started += 1);
    createWebNotificationController({ pushEnabled: true, host: env.host, reconcileOnStart: false });
    assert.equal(started, 1);
  });

  it("skips notifications only while the page is focused on that very task, or permission is missing", async () => {
    const focused = createEnv({ permission: "granted", existingSubscription: true });
    focused.setFocused(true);
    const focusedController = createWebNotificationController({
      pushEnabled: true,
      host: focused.host,
      reconcileOnStart: false,
    });
    focusedController.syncActiveTaskSession("task-1");
    focusedController.showTaskNotification(payload);
    await flush();
    assert.equal(focused.shown.length, 0);

    // 聚焦但在看别的任务：后台任务的通知照常展示。
    focusedController.syncActiveTaskSession("task-other");
    focusedController.showTaskNotification(payload);
    await flush();
    assert.equal(focused.shown.length, 1);

    // 页面不在前台时，即使记录的是同一个任务也要提示。
    const background = createEnv({ permission: "granted", existingSubscription: true });
    const backgroundController = createWebNotificationController({
      pushEnabled: true,
      host: background.host,
      reconcileOnStart: false,
    });
    backgroundController.syncActiveTaskSession("task-1");
    backgroundController.showTaskNotification(payload);
    await flush();
    assert.equal(background.shown.length, 1);

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

  it("closes a pushed notification right away only when the page is viewing that task", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    controller.syncActiveTaskSession("task-1");
    env.setFocused(true);
    env.displayed.push({ tag: "zcode:task:task-1:terminal", closed: false });
    env.displayed.push({ tag: "zcode:task:task-2:terminal", closed: false });
    env.displayed.push({ tag: "other", closed: false });
    // 前台标签页在看任务 A：后台任务 B 的推送不能被误关。
    env.sw.emit("message", {
      data: { type: "zcode:web-push-shown", tag: "zcode:task:task-2:terminal", taskId: "task-2" },
    });
    await flush();
    assert.deepEqual(
      env.displayed.map((item) => item.closed),
      [false, false, false],
    );
    env.sw.emit("message", {
      data: { type: "zcode:web-push-shown", tag: "zcode:task:task-1:terminal", taskId: "task-1" },
    });
    await flush();
    assert.deepEqual(
      env.displayed.map((item) => item.closed),
      [true, false, false],
    );

    // 不在前台的页面不收回，即使正是它记录的任务。
    env.setFocused(false);
    env.displayed.push({ tag: "zcode:task:task-1:terminal", closed: false });
    env.sw.emit("message", {
      data: { type: "zcode:web-push-shown", tag: "zcode:task:task-1:terminal", taskId: "task-1" },
    });
    await flush();
    assert.equal(env.displayed[3]?.closed, false);
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

  it("keeps other tasks' notifications when the page regains focus", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    controller.syncActiveTaskSession("task-a");
    env.displayed.push({
      tag: "zcode:task:task-a:terminal",
      data: { taskId: "task-a" },
      closed: false,
    });
    env.displayed.push({
      tag: "zcode:task:task-b:terminal",
      data: { taskId: "task-b" },
      closed: false,
    });
    env.displayed.push({ tag: "zcode:generic", closed: false });
    env.setFocused(true);
    env.windowEvents.emit("focus");
    await flush();
    assert.deepEqual(
      env.displayed.map((item) => item.closed),
      [true, false, true],
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

  /** 把 registration.active 换成可编程的假 Service Worker，记录页面发来的请求。 */
  async function attachWorker(
    env: Env,
    respond: ((message: any, port: MessagePort) => void) | null,
  ): Promise<any[]> {
    const requests: any[] = [];
    const registration = await (
      env.host.navigator.serviceWorker as unknown as { getRegistration(): Promise<any> }
    ).getRegistration();
    registration.active = {
      postMessage: (message: unknown, transfer: MessagePort[]) => {
        requests.push(message);
        respond?.(message, transfer[0]!);
      },
    };
    return requests;
  }

  it("lets the service worker decide: it shows once and only the answered page rings", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    let sounds = 0;
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
      playSound: () => void (sounds += 1),
    });
    const requests = await attachWorker(env, (_message, port) =>
      port.postMessage({ shown: true, playSound: true }),
    );
    controller.showTaskNotification({ ...payload, workspacePath: "/repo" });
    await flush();
    assert.deepEqual(plain(requests), [
      {
        type: "zcode:show-task-notification",
        tag: "zcode:task:task-1:terminal",
        payload: { ...payload, workspacePath: "/repo" },
      },
    ]);
    assert.equal(env.shown.length, 0, "页面不直接展示");
    assert.equal(sounds, 1);
  });

  it("stays quiet when the service worker says another tab owns the notification", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    let sounds = 0;
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
      playSound: () => void (sounds += 1),
    });
    await attachWorker(env, (_message, port) =>
      port.postMessage({ shown: false, playSound: false }),
    );
    controller.showTaskNotification(payload);
    await flush();
    assert.equal(env.shown.length, 0);
    assert.equal(env.legacyNotifications.length, 0);
    assert.equal(sounds, 0);
    // 本页仍记住该 tag，4 秒内不会再次打扰 Service Worker。
    controller.showTaskNotification(payload);
    await flush();
    assert.equal(env.shown.length, 0);
  });

  it("shows the notification itself when the service worker reports an error", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    let sounds = 0;
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
      playSound: () => void (sounds += 1),
    });
    await attachWorker(env, (_message, port) =>
      port.postMessage({ shown: false, playSound: false, error: true }),
    );
    controller.showTaskNotification(payload);
    await flush();
    assert.equal(env.shown.length, 1);
    assert.equal(sounds, 1);
  });

  it("reports the active task and workspaces when the service worker asks", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    env.setFocused(true);
    const controller = createWebNotificationController({
      pushEnabled: true,
      host: env.host,
      reconcileOnStart: false,
    });
    const query = async () => {
      const channel = new MessageChannel();
      const reply = new Promise((resolve) => {
        channel.port1.onmessage = (event) => resolve(event.data);
      });
      env.sw.emit("message", {
        data: { type: "zcode:query-client-state" },
        ports: [channel.port2],
      });
      const state = await reply;
      channel.port1.close();
      return state;
    };
    assert.deepEqual(await query(), {
      focused: true,
      activeTaskId: null,
      activeWorkspacePath: null,
      openWorkspacePaths: [],
    });

    controller.syncWindowTabs(["/repo/b", "/repo/a", "/repo/b"]);
    controller.syncActiveTaskSession("task-7");
    assert.deepEqual(await query(), {
      focused: true,
      activeTaskId: "task-7",
      activeWorkspacePath: "/repo/b",
      openWorkspacePaths: ["/repo/b", "/repo/a", "/repo/b"],
    });

    // 尚无激活工作区时首项为空串，不能把第一个已打开的工作区当成激活的。
    controller.syncWindowTabs(["", "/repo/a"]);
    controller.syncActiveTaskSession(null);
    env.setFocused(false);
    assert.deepEqual(await query(), {
      focused: false,
      activeTaskId: null,
      activeWorkspacePath: null,
      openWorkspacePaths: ["/repo/a"],
    });
  });

  it("does not answer state queries on the Web remote control page", async () => {
    const env = createEnv({ permission: "granted", existingSubscription: true });
    createWebNotificationController({
      pushEnabled: false,
      host: env.host,
      reconcileOnStart: false,
    });
    let replied = false;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => void (replied = true);
    env.sw.emit("message", { data: { type: "zcode:query-client-state" }, ports: [channel.port2] });
    await flush();
    channel.port1.close();
    assert.equal(replied, false);
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

  /** 内存版 Cache Storage；同一个实例传给多次 loadWorker 即模拟 Service Worker 重启后读回持久记录。 */
  function createFakeCaches() {
    const entries = new Map<string, string>();
    return {
      open: async () => ({
        match: async (url: string) =>
          entries.has(url) ? new Response(entries.get(url)) : undefined,
        put: async (url: string, response: Response) =>
          void entries.set(url, await response.text()),
      }),
    };
  }

  async function loadWorker(
    windowClients: Array<Record<string, unknown>>,
    userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
    caches?: ReturnType<typeof createFakeCaches>,
  ) {
    const { readFile } = await import("node:fs/promises");
    const vm = await import("node:vm");
    const handlers = new Map<string, (event: any) => void>();
    let showFails = false;
    let openWindowFails = false;
    let beforeShow: (() => Promise<void>) | undefined;
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
        get: async (id: string) => windowClients.find((client) => client.id === id),
        openWindow: async (url: string) => {
          if (openWindowFails) throw new Error("InvalidAccessError");
          calls.opened.push(url);
          return { url };
        },
      },
      ...(caches ? { caches } : {}),
      registration: {
        showNotification: async (title: string, options: any) => {
          if (showFails) throw new TypeError("Illegal constructor");
          await beforeShow?.();
          calls.shown.push({ title, options });
        },
        getNotifications: async ({ tag }: { tag: string }) => [
          { close: () => calls.closed.push(tag) },
        ],
      },
    };
    // vm 内创建的对象原型属于另一个 realm，断言前统一转成普通 JSON。
    vm.runInNewContext(await readFile(scriptPath, "utf8"), {
      self,
      URL,
      console,
      Date,
      MessageChannel,
      Response,
      setTimeout,
      clearTimeout,
    });
    const dispatch = async (type: string, event: Record<string, unknown>) => {
      const waits: Promise<unknown>[] = [];
      handlers.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
      await Promise.all(waits);
    };
    return {
      calls,
      dispatch,
      setBeforeShow: (hook: (() => Promise<void>) | undefined) => {
        beforeShow = hook;
      },
      setShowFails: (value: boolean) => {
        showFails = value;
      },
      setOpenWindowFails: (value: boolean) => {
        openWindowFails = value;
      },
    };
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

  interface PageState {
    focused: boolean;
    activeTaskId?: string | null;
    activeWorkspacePath?: string | null;
    openWorkspacePaths?: string[];
  }

  /**
   * 模拟工作台标签页。收到 zcode:query-client-state 时按 pageState 经传入的端口回复；
   * 不给 pageState 就不回复，模拟挂起的标签页（Service Worker 会在超时后按“未知”处理）。
   * 真实 WindowClient.focus() 会 resolve 聚焦后的 client；Android 后台时它仍可能不可见。
   */
  const makeWindowClient = (
    url: string,
    extra: Record<string, unknown> & {
      onFocus?: () => void;
      onMessage?: (message: unknown) => void;
      focusResult?: "self" | "throw" | { focused?: boolean; visibilityState?: string };
      pageState?: PageState;
    } = {},
  ) => {
    const { onFocus, onMessage, focusResult = "self", pageState, ...state } = extra;
    const client: Record<string, unknown> = {
      url,
      focused: false,
      visibilityState: "visible",
      ...state,
      postMessage: (message: any, transfer?: any[]) => {
        if (message?.type === "zcode:query-client-state") {
          if (pageState) transfer?.[0]?.postMessage(pageState);
          return;
        }
        onMessage?.(message);
      },
    };
    client.focus = async () => {
      onFocus?.();
      if (focusResult === "throw") throw new Error("focus denied");
      if (focusResult === "self") return client;
      return { ...client, ...focusResult, postMessage: client.postMessage };
    };
    return client;
  };

  const WORKBENCH_URL = "https://zcode.example/";
  /** 点击只复用已经打开着该任务的标签页，下列单窗口用例都让窗口回报正在展示 t1。 */
  const SHOWING_T1: PageState = { focused: false, activeTaskId: "t1" };

  it("shows a notification and tells background tabs", async () => {
    const posted: unknown[] = [];
    const tab = makeWindowClient(WORKBENCH_URL, {
      onMessage: (message) => posted.push(message),
      pageState: { focused: false },
    });
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
      {
        type: "zcode:web-push-shown",
        tag: "zcode:task:t1:terminal",
        eventId: "e1",
        taskId: "t1",
      },
    ]);
  });

  it("broadcasts the secondary tag and honours silent", async () => {
    const posted: unknown[] = [];
    const { calls, dispatch } = await loadWorker([
      makeWindowClient(WORKBENCH_URL, {
        onMessage: (message) => posted.push(message),
        pageState: { focused: false },
      }),
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
        taskId: "t1",
      },
    ]);
  });

  it("skips a push only when a focused workbench is viewing that very task on non-Apple browsers", async () => {
    const viewing = makeWindowClient(WORKBENCH_URL, {
      pageState: { focused: true, activeTaskId: "t1" },
    });
    const chrome = await loadWorker([viewing]);
    await chrome.dispatch("push", pushEvent(showPayload));
    assert.equal(chrome.calls.shown.length, 0);

    // 另一个任务、后台、没有任务、挂起未回复（有 taskId 时以精确匹配为准）、非工作台页面都不豁免。
    const state = (extra: PageState): { pageState: PageState } => ({ pageState: extra });
    for (const [label, client] of [
      [
        "viewing another task",
        makeWindowClient(WORKBENCH_URL, state({ focused: true, activeTaskId: "t2" })),
      ],
      [
        "viewing the task in the background",
        makeWindowClient(WORKBENCH_URL, state({ focused: false, activeTaskId: "t1" })),
      ],
      [
        "focused on settings",
        makeWindowClient(WORKBENCH_URL, state({ focused: true, activeTaskId: null })),
      ],
      [
        "unresponsive but visible and focused",
        makeWindowClient(WORKBENCH_URL, { focused: true, visibilityState: "visible" }),
      ],
      ...[
        "https://zcode.example/remote/v4",
        "https://zcode.example/share/abc",
        "https://zcode.example/cn/share/abc",
        "https://evil.example/",
      ].map(
        (url) =>
          [url, makeWindowClient(url, state({ focused: true, activeTaskId: "t1" }))] as const,
      ),
    ] as const) {
      const worker = await loadWorker([client]);
      await worker.dispatch("push", pushEvent(showPayload));
      assert.equal(worker.calls.shown.length, 1, label);
    }
  });

  it("falls back to generic foreground suppression for a push without a task", async () => {
    const genericPush = { ...showPayload, taskId: undefined };
    const cases: Array<[string, Record<string, unknown>, number]> = [
      ["replied focused", { pageState: { focused: true, activeTaskId: "t9" } }, 0],
      ["replied unfocused", { focused: true, pageState: { focused: false } }, 1],
      ["unresponsive visible and focused", { focused: true, visibilityState: "visible" }, 0],
      ["unresponsive hidden", { focused: true, visibilityState: "hidden" }, 1],
    ];
    for (const [label, extra, expectedShown] of cases) {
      const worker = await loadWorker([makeWindowClient(WORKBENCH_URL, extra)]);
      await worker.dispatch("push", pushEvent(genericPush));
      assert.equal(worker.calls.shown.length, expectedShown, label);
    }
  });

  it("always shows on iOS and Mac Safari, even when the task is being viewed, and reports the task", async () => {
    const posted: unknown[] = [];
    const focusedWorkbench = () =>
      makeWindowClient("https://zcode.example/index.html", {
        focused: true,
        onMessage: (message) => posted.push(message),
        pageState: { focused: true, activeTaskId: "t1" },
      });
    for (const userAgent of [
      IOS_UA,
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15",
    ]) {
      posted.length = 0;
      const { calls, dispatch } = await loadWorker([focusedWorkbench()], userAgent);
      await dispatch("push", pushEvent(showPayload));
      assert.equal(calls.shown.length, 1);
      assert.equal((plain(posted)[0] as { taskId?: string }).taskId, "t1");
    }
    // iOS Chrome / Firefox (CriOS / FxiOS) 底层同样是 Apple WebKit，不能跳过展示。
    const crios = await loadWorker(
      [focusedWorkbench()],
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 CriOS/124 Mobile/15E148 Safari/604.1",
    );
    await crios.dispatch("push", pushEvent(showPayload));
    assert.equal(crios.calls.shown.length, 1);

    // Android Chrome 属于真 Chromium，前台正在看该任务时允许跳过展示。
    const androidChrome = await loadWorker(
      [focusedWorkbench()],
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
      makeWindowClient("https://zcode.example/remote/v4"),
      makeWindowClient("https://zcode.example/?foo=1", {
        onFocus: () => void (focused += 1),
        onMessage: (message) => messages.push(message),
        pageState: SHOWING_T1,
      }),
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

  it("posts the message to the focused client the browser resolved, without reloading", async () => {
    const messages: unknown[] = [];
    const { calls, dispatch } = await loadWorker([
      makeWindowClient("https://zcode.example/", {
        visibilityState: "hidden",
        onMessage: (message) => messages.push(["original", message]),
        focusResult: { focused: true, visibilityState: "visible" },
        pageState: SHOWING_T1,
      }),
    ]);
    await dispatch("notificationclick", {
      notification: { close: () => {}, data: { taskId: "t1", workspacePath: "/repo" } },
    });
    assert.equal(messages.length, 1);
    assert.deepEqual(calls.opened, []);
  });

  it("opens the deep link without navigating the hidden client when focus() rejects", async () => {
    const messages: unknown[] = [];
    const { calls, dispatch, setOpenWindowFails } = await loadWorker([
      makeWindowClient("https://zcode.example/", {
        visibilityState: "hidden",
        focusResult: "throw",
        onMessage: (message) => messages.push(message),
        pageState: SHOWING_T1,
      }),
    ]);
    await dispatch("notificationclick", {
      notification: {
        close: () => {},
        data: { taskId: "t1", workspacePath: "/repo", workspaceIdentity: "id-1" },
      },
    });
    assert.equal(messages.length, 0);
    assert.deepEqual(calls.opened, [
      "https://zcode.example/?zcodeTask=t1&zcodeWorkspace=%2Frepo&zcodeWorkspaceIdentity=id-1",
    ]);

    // 仅当 openWindow 也拒绝（如 Chromium 交互令牌被 focus() 消耗）才回退发消息给已选目标窗口。
    setOpenWindowFails(true);
    await dispatch("notificationclick", {
      notification: {
        close: () => {},
        data: { taskId: "t1", workspacePath: "/repo", workspaceIdentity: "id-1" },
      },
    });
    assert.equal(messages.length, 1);
  });

  it("opens the deep link without navigating a hidden client when focus() resolves non-foreground", async () => {
    const messages: unknown[] = [];
    const { calls, dispatch } = await loadWorker([
      makeWindowClient("https://zcode.example/", {
        visibilityState: "hidden",
        onMessage: (message) => messages.push(message),
        focusResult: { focused: false, visibilityState: "hidden" },
        pageState: SHOWING_T1,
      }),
    ]);
    await dispatch("notificationclick", {
      notification: { close: () => {}, data: { taskId: "t1", workspacePath: "/repo" } },
    });
    assert.equal(messages.length, 0);
    assert.deepEqual(calls.opened, ["https://zcode.example/?zcodeTask=t1&zcodeWorkspace=%2Frepo"]);
  });

  it("opens the deep link when focus() resolves nothing", async () => {
    const { calls, dispatch } = await loadWorker([
      {
        url: "https://zcode.example/",
        visibilityState: "hidden",
        focus: async () => undefined,
        postMessage: () => {},
      },
    ]);
    await dispatch("notificationclick", {
      notification: { close: () => {}, data: { taskId: "t1" } },
    });
    assert.deepEqual(calls.opened, ["https://zcode.example/?zcodeTask=t1"]);
  });

  it("prefers the focused or visible workbench window when several are open", async () => {
    const messages: string[] = [];
    const named = (name: string, extra: Record<string, unknown>) =>
      makeWindowClient("https://zcode.example/", {
        onMessage: () => messages.push(name),
        pageState: SHOWING_T1,
        ...extra,
      });
    const { dispatch } = await loadWorker([
      named("background", { visibilityState: "hidden", focused: false }),
      named("visible", { visibilityState: "visible", focused: false }),
      named("focused", { visibilityState: "visible", focused: true }),
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

  /** 经 MessageChannel 向 Service Worker 发页内通知请求，返回它的裁决。 */
  async function requestShow(
    dispatch: (type: string, event: Record<string, unknown>) => Promise<void>,
    request: unknown,
  ) {
    const channel = new MessageChannel();
    const reply = new Promise((resolve) => {
      channel.port1.onmessage = (event) => resolve(event.data);
    });
    await dispatch("message", { data: request, ports: [channel.port2] });
    const decision = plain(await reply);
    channel.port1.close();
    return decision;
  }

  const taskRequest = (extra: Record<string, unknown> = {}) => ({
    type: "zcode:show-task-notification",
    tag: "zcode:task:t1:terminal",
    payload: {
      taskId: "t1",
      status: "completed",
      title: "Task completed",
      body: "Task: demo",
      workspacePath: "/repo",
      ...extra,
    },
  });

  it("shows page notifications silently once per tag across tabs and pushes", async () => {
    const worker = await loadWorker([
      makeWindowClient(WORKBENCH_URL, { pageState: { focused: false } }),
    ]);
    assert.deepEqual(await requestShow(worker.dispatch, taskRequest()), {
      shown: true,
      playSound: true,
    });
    assert.equal(worker.calls.shown.length, 1);
    assert.deepEqual(plain(worker.calls.shown[0]?.options), {
      body: "Task: demo",
      tag: "zcode:task:t1:terminal",
      silent: true,
      icon: "/icon-192.png",
      data: { taskId: "t1", workspacePath: "/repo", tag: "zcode:task:t1:terminal" },
    });
    // 同一 tag 4 秒内（无论来自别的标签页还是刚到的推送）不再展示、不再响铃。
    assert.deepEqual(await requestShow(worker.dispatch, taskRequest()), {
      shown: false,
      playSound: false,
    });
    assert.equal(worker.calls.shown.length, 1);

    // 推送展示过的 tag 同样让随后的页内请求让路；推送本身永远展示（userVisibleOnly）。
    const afterPush = await loadWorker([]);
    await afterPush.dispatch("push", pushEvent(showPayload));
    assert.deepEqual(await requestShow(afterPush.dispatch, taskRequest()), {
      shown: false,
      playSound: false,
    });
    await afterPush.dispatch("push", pushEvent(showPayload));
    assert.equal(afterPush.calls.shown.length, 2);
  });

  it("skips a push that repeats a page notification when a workbench window is visible, and silently merges when hidden", async () => {
    // 有可见同源工作台窗口（Chromium 豁免 userVisibleOnly）：直接跳过重复展示。
    const visibleChrome = await loadWorker([
      makeWindowClient(WORKBENCH_URL, {
        visibilityState: "visible",
        pageState: { focused: false },
      }),
    ]);
    assert.equal((await requestShow(visibleChrome.dispatch, taskRequest())).shown, true);
    await visibleChrome.dispatch("push", pushEvent(showPayload));
    assert.equal(visibleChrome.calls.shown.length, 1);
    await visibleChrome.dispatch(
      "push",
      pushEvent({ ...showPayload, tag: "zcode:automation:run-1", secondaryTag: showPayload.tag }),
    );
    assert.equal(visibleChrome.calls.shown.length, 1);
    // 不同 tag 的 push 不受影响。
    await visibleChrome.dispatch(
      "push",
      pushEvent({ ...showPayload, tag: "zcode:task:t2:terminal" }),
    );
    assert.equal(visibleChrome.calls.shown.length, 2);

    // 所有窗口都已最小化不可见时：调用 silent+renotify:false 平滑合并，严格满足 Chromium userVisibleOnly 配额。
    const hiddenChrome = await loadWorker([
      makeWindowClient(WORKBENCH_URL, {
        visibilityState: "hidden",
        pageState: { focused: false },
      }),
    ]);
    assert.equal((await requestShow(hiddenChrome.dispatch, taskRequest())).shown, true);
    await hiddenChrome.dispatch("push", pushEvent({ ...showPayload, silent: false }));
    assert.equal(hiddenChrome.calls.shown.length, 2);
    assert.equal(hiddenChrome.calls.shown[1]?.options.silent, true);
    assert.equal(hiddenChrome.calls.shown[1]?.options.renotify, false);

    const automation = await loadWorker([]);
    assert.equal((await requestShow(automation.dispatch, taskRequest())).shown, true);
    await automation.dispatch(
      "push",
      pushEvent({
        ...showPayload,
        silent: false,
        tag: "zcode:automation:run-1",
        secondaryTag: showPayload.tag,
      }),
    );
    assert.equal(automation.calls.shown[1]?.options.tag, showPayload.tag);
    assert.equal(automation.calls.shown[1]?.options.silent, true);
    assert.equal(automation.calls.shown[1]?.options.renotify, false);

    // Apple WebKit 每条 push 必须有可见通知（userVisibleOnly），不能因为页内刚提示过而跳过。
    const ios = await loadWorker(
      [makeWindowClient(WORKBENCH_URL, { pageState: { focused: false } })],
      IOS_UA,
    );
    assert.equal((await requestShow(ios.dispatch, taskRequest())).shown, true);
    await ios.dispatch("push", pushEvent(showPayload));
    assert.equal(ios.calls.shown.length, 2);
  });

  it("waits for an in-flight page notification before deciding whether a push is a duplicate", async () => {
    let finishShow!: () => void;
    let startShow!: () => void;
    const showing = new Promise<void>((resolve) => {
      startShow = resolve;
    });
    const release = new Promise<void>((resolve) => {
      finishShow = resolve;
    });
    const worker = await loadWorker([
      makeWindowClient(WORKBENCH_URL, {
        visibilityState: "visible",
        pageState: { focused: false },
      }),
    ]);
    worker.setBeforeShow(async () => {
      if (worker.calls.shown.length === 0) {
        startShow();
        await release;
        throw new Error("Could not display the page notification");
      }
    });
    const pendingPage = requestShow(worker.dispatch, taskRequest());
    await showing;
    worker.setBeforeShow(undefined);
    const pendingPush = worker.dispatch("push", pushEvent(showPayload));
    finishShow();
    assert.equal((await pendingPage).error, true);
    await pendingPush;
    assert.equal(worker.calls.shown.length, 1);
    assert.equal(worker.calls.shown[0]?.options.tag, showPayload.tag);
  });

  it("does not show a page notification while another focused tab is viewing the task, and does not hold the tag", async () => {
    const worker = await loadWorker([
      makeWindowClient(WORKBENCH_URL, { pageState: { focused: true, activeTaskId: "t1" } }),
    ]);
    assert.deepEqual(await requestShow(worker.dispatch, taskRequest()), {
      shown: false,
      playSound: false,
    });
    assert.equal(worker.calls.shown.length, 0);

    // 查看者离开后，同一事件再次请求可以正常展示。
    const left = await loadWorker([
      makeWindowClient(WORKBENCH_URL, { pageState: { focused: true, activeTaskId: "other" } }),
    ]);
    assert.deepEqual(await requestShow(left.dispatch, taskRequest()), {
      shown: true,
      playSound: true,
    });
  });

  it("rejects malformed page requests and releases the tag when showing fails", async () => {
    const worker = await loadWorker([]);
    for (const request of [
      { type: "zcode:show-task-notification" },
      { ...taskRequest(), tag: "" },
      taskRequest({ taskId: "" }),
      taskRequest({ title: 1 }),
    ]) {
      assert.deepEqual(await requestShow(worker.dispatch, request), {
        shown: false,
        playSound: false,
        error: true,
      });
    }
    assert.equal(worker.calls.shown.length, 0);

    // 第一次展示失败后 tag 必须释放，第二次才能成功。
    const failing = await loadWorker([]);
    failing.setShowFails(true);
    assert.deepEqual(await requestShow(failing.dispatch, taskRequest()), {
      shown: false,
      playSound: false,
      error: true,
    });
    failing.setShowFails(false);
    assert.deepEqual(await requestShow(failing.dispatch, taskRequest()), {
      shown: true,
      playSound: true,
    });
    assert.equal(failing.calls.shown.length, 1);
  });

  it("ignores unrelated worker messages", async () => {
    const { calls, dispatch } = await loadWorker([]);
    await dispatch("message", { data: null, ports: [] });
    await dispatch("message", { data: { type: "other" }, ports: [] });
    assert.equal(calls.shown.length, 0);
  });

  describe("click routing across several workbench tabs", () => {
    const click = (data: Record<string, unknown>) => ({ notification: { close: () => {}, data } });

    function openTabs(
      states: Array<PageState | undefined>,
      extras: Array<Record<string, unknown>> = [],
    ) {
      const log: string[] = [];
      const clients = states.map((pageState, index) =>
        makeWindowClient(WORKBENCH_URL, {
          pageState,
          onFocus: () => log.push(`focus:${index}`),
          onMessage: (message) =>
            log.push(`message:${index}:${(message as { type: string }).type}`),
          ...extras[index],
        }),
      );
      return { log, clients };
    }

    it("focuses the tab that already shows the task and leaves the other tab alone", async () => {
      const { log, clients } = openTabs([
        {
          focused: false,
          activeTaskId: "task-a",
          activeWorkspacePath: "/repo",
          openWorkspacePaths: ["/repo"],
        },
        {
          focused: false,
          activeTaskId: "task-b",
          activeWorkspacePath: "/repo",
          openWorkspacePaths: ["/repo"],
        },
      ]);
      const { calls, dispatch } = await loadWorker(clients);
      await dispatch("notificationclick", click({ taskId: "task-b", workspacePath: "/repo" }));
      assert.deepEqual(log, ["focus:1", "message:1:zcode:notification-click"]);
      assert.deepEqual(calls.opened, []);
    });

    it("prefers the focused tab when several tabs show the same task", async () => {
      const same = { activeTaskId: "task-a", openWorkspacePaths: ["/repo"] };
      const { log, clients } = openTabs(
        [
          { focused: false, ...same },
          { focused: false, ...same },
          { focused: true, ...same },
        ],
        [{ visibilityState: "hidden" }, { visibilityState: "visible" }, { focused: true }],
      );
      const { dispatch } = await loadWorker(clients);
      await dispatch("notificationclick", click({ taskId: "task-a", workspacePath: "/repo" }));
      assert.deepEqual(log, ["focus:2", "message:2:zcode:notification-click"]);
    });

    it("opens a deep link for a pure push instead of taking over tabs on other tasks or settings", async () => {
      const states: PageState[] = [
        {
          focused: false,
          activeTaskId: "x",
          activeWorkspacePath: "/one",
          openWorkspacePaths: ["/one", "/three"],
        },
        { focused: true, activeTaskId: null, activeWorkspacePath: "", openWorkspacePaths: [] },
      ];
      // 同工作区、已打开工作区或聚焦的设置页都不复用：只认正在展示该任务的标签页。
      for (const data of [
        { taskId: "unknown", workspacePath: "/one" },
        { taskId: "unknown", workspacePath: "/three" },
        { taskId: "unknown" },
      ]) {
        const { log, clients } = openTabs(states, [{}, { focused: true }]);
        const { calls, dispatch } = await loadWorker(clients);
        await dispatch("notificationclick", click(data));
        assert.deepEqual(log, [], JSON.stringify(data));
        assert.equal(calls.opened.length, 1);
      }
      // 没有任务归属的通用通知只需拉起工作台，取聚焦的标签页。
      const { log, clients } = openTabs(states, [{}, { focused: true }]);
      const { dispatch } = await loadWorker(clients);
      await dispatch("notificationclick", click({}));
      assert.deepEqual(log, ["focus:1", "message:1:zcode:notification-click"]);
    });

    it("merges a late push and the page notification for one turn, keeps the origin tab across restarts, and still rings for the next turn", async () => {
      const caches = createFakeCaches();
      const turn1 = "zcode:event:turn:t1:1000";
      const { log, clients } = openTabs(
        [
          { focused: false, activeTaskId: "other" },
          { focused: false, activeTaskId: "x" },
        ],
        [
          {
            id: "origin",
            visibilityState: "hidden",
            focusResult: { focused: true, visibilityState: "visible" },
          },
          { id: "tab-2", visibilityState: "hidden" },
        ],
      );

      // 推送先到（标签页都在后台）：展示并提醒。
      const first = await loadWorker(clients, undefined, caches);
      await first.dispatch("push", pushEvent({ ...showPayload, eventKey: turn1 }));
      assert.equal(first.calls.shown.length, 1);
      assert.equal(first.calls.shown[0]?.options.renotify, true);
      assert.equal(first.calls.shown[0]?.options.data.eventKey, turn1);

      // 随后同一事件的页内请求：不再展示、不响铃，只登记发起页。
      const channel = new MessageChannel();
      const reply = new Promise((resolve) => {
        channel.port1.onmessage = (event) => resolve(event.data);
      });
      await first.dispatch("message", {
        data: taskRequest({ eventKey: turn1 }),
        ports: [channel.port2],
        source: clients[0],
      });
      assert.deepEqual(plain(await reply), { shown: false, playSound: false });
      channel.port1.close();
      assert.equal(first.calls.shown.length, 1);

      // Service Worker 重启后：重复投递在 userVisibleOnly 下静默替换原槽位，不再提醒。
      const restarted = await loadWorker(clients, undefined, caches);
      await restarted.dispatch("push", pushEvent({ ...showPayload, eventKey: turn1 }));
      assert.equal(restarted.calls.shown.length, 1);
      assert.equal(restarted.calls.shown[0]?.options.silent, true);
      assert.equal(restarted.calls.shown[0]?.options.renotify, false);

      // 点击回到登记的发起页，即使它此刻停在别的任务上。
      log.length = 0;
      await restarted.dispatch(
        "notificationclick",
        click({ taskId: "t1", eventKey: turn1, workspacePath: "/repo" }),
      );
      assert.deepEqual(log, ["focus:0", "message:0:zcode:notification-click"]);
      assert.deepEqual(restarted.calls.opened, []);

      // 同一会话的下一轮回合是新事件：照常展示并提醒。
      await restarted.dispatch(
        "push",
        pushEvent({ ...showPayload, eventKey: "zcode:event:turn:t1:2000" }),
      );
      assert.equal(restarted.calls.shown.length, 2);
      assert.equal(restarted.calls.shown[1]?.options.silent, false);
      assert.equal(restarted.calls.shown[1]?.options.renotify, true);
    });

    it("treats unresponsive tabs as unknown and still picks the best answering tab", async () => {
      const { log, clients } = openTabs([
        undefined,
        { focused: false, activeTaskId: "task-b", openWorkspacePaths: [] },
      ]);
      const { dispatch } = await loadWorker(clients);
      await dispatch("notificationclick", click({ taskId: "task-b" }));
      assert.deepEqual(log, ["focus:1", "message:1:zcode:notification-click"]);
    });
  });

  describe("two real controllers sharing one service worker", () => {
    const payloadFor = (taskId: string) => ({
      taskId,
      status: "completed" as const,
      title: `Task ${taskId} completed`,
      body: `Task: ${taskId}`,
      workspacePath: "/repo",
    });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

    async function openBrowser(
      tabCount: number,
      options: { userAgent?: string; workspaces?: string[] } = {},
    ) {
      const windowClients: Array<Record<string, unknown>> = [];
      const worker = await loadWorker(windowClients, options.userAgent);
      const tabs = Array.from({ length: tabCount }, (_unused, index) => {
        const env = createEnv({ permission: "granted", existingSubscription: true });
        const tab = {
          index,
          env,
          sounds: 0,
          clicks: [] as string[],
          focused: false,
          controller: createWebNotificationController({
            pushEnabled: true,
            host: env.host,
            reconcileOnStart: false,
            playSound: () => void (tab.sounds += 1),
          }),
          setFocused(value: boolean) {
            tab.focused = value;
            env.setFocused(value);
          },
        };
        tab.controller.onTaskNotificationClick((taskId) => tab.clicks.push(taskId));
        tab.controller.syncWindowTabs(["/repo", ...(options.workspaces ?? [])]);
        return tab;
      });
      const focusLog: number[] = [];
      for (const tab of tabs) {
        const registration = await (
          tab.env.host.navigator.serviceWorker as unknown as {
            getRegistration(): Promise<{ active: unknown }>;
          }
        ).getRegistration();
        registration.active = {
          postMessage: (message: unknown, transfer: unknown[]) =>
            void worker.dispatch("message", { data: message, ports: transfer }),
        };
        const client: Record<string, unknown> = {
          url: WORKBENCH_URL,
          get focused() {
            return tab.focused;
          },
          get visibilityState() {
            return tab.focused ? "visible" : "hidden";
          },
          postMessage: (message: unknown, transfer?: unknown[]) =>
            tab.env.sw.emit("message", { data: message, ports: transfer ?? [] }),
          focus: async () => {
            focusLog.push(tab.index);
            // 真实浏览器里 focus() 成功后该标签页就是前台。
            for (const other of tabs) other.setFocused(other === tab);
            return client;
          },
        };
        windowClients.push(client);
      }
      return { tabs, worker, focusLog };
    }

    it("tab 1 viewing task A suppresses the notification and sound for task A from background tab 2", async () => {
      const { tabs, worker } = await openBrowser(2);
      const [tab1, tab2] = [tabs[0]!, tabs[1]!];
      tab1.setFocused(true);
      tab1.controller.syncActiveTaskSession("task-a");
      tab2.controller.syncActiveTaskSession("task-a");
      tab2.controller.showTaskNotification(payloadFor("task-a"));
      await settle();
      assert.equal(worker.calls.shown.length, 0);
      assert.deepEqual([tab1.sounds, tab2.sounds], [0, 0]);
      // 页面自己不得绕过 Service Worker 直接展示。
      assert.deepEqual([tab1.env.shown.length, tab2.env.shown.length], [0, 0]);

      // 同一任务的推送同样被前台查看者吸收。
      await worker.dispatch(
        "push",
        pushEvent({ ...showPayload, taskId: "task-a", tag: "zcode:task:task-a:terminal" }),
      );
      assert.equal(worker.calls.shown.length, 0);
    });

    it("tab 1 viewing task A still notifies, with a single sound, for background task B", async () => {
      const { tabs, worker } = await openBrowser(2);
      const [tab1, tab2] = [tabs[0]!, tabs[1]!];
      tab1.setFocused(true);
      tab1.controller.syncActiveTaskSession("task-a");
      tab2.controller.syncActiveTaskSession("task-a");
      tab1.controller.showTaskNotification(payloadFor("task-b"));
      tab2.controller.showTaskNotification(payloadFor("task-b"));
      await settle();
      assert.equal(worker.calls.shown.length, 1);
      assert.equal(worker.calls.shown[0]?.options.tag, "zcode:task:task-b:terminal");
      assert.equal(worker.calls.shown[0]?.options.silent, true);
      assert.equal(tab1.sounds + tab2.sounds, 1);

      // 非 Apple 浏览器的推送：前台只在看任务 A，任务 B 的推送正常展示，任务 A 的被吸收。
      await worker.dispatch(
        "push",
        pushEvent({ ...showPayload, taskId: "task-c", tag: "zcode:task:task-c:terminal" }),
      );
      assert.equal(worker.calls.shown.length, 2);
      await worker.dispatch(
        "push",
        pushEvent({ ...showPayload, taskId: "task-a", tag: "zcode:task:task-a:terminal" }),
      );
      assert.equal(worker.calls.shown.length, 2);
    });

    it("two background tabs on the same project show one notification and ring once", async () => {
      const { tabs, worker } = await openBrowser(2);
      const [tab1, tab2] = [tabs[0]!, tabs[1]!];
      tab1.controller.showTaskNotification(payloadFor("task-a"));
      tab2.controller.showTaskNotification(payloadFor("task-a"));
      await settle();
      assert.equal(worker.calls.shown.length, 1);
      assert.deepEqual([tab1.sounds, tab2.sounds], [1, 0]);
      assert.deepEqual([tab1.env.shown.length, tab2.env.shown.length], [0, 0]);
      // 4 秒窗口内再来一次同一事件仍然不重复。
      tab2.controller.showTaskNotification(payloadFor("task-a"));
      await settle();
      assert.equal(worker.calls.shown.length, 1);
      assert.deepEqual([tab1.sounds, tab2.sounds], [1, 0]);
    });

    it("retains originClientId in data for non-keyed page notifications and across silent push merges", async () => {
      const log: string[] = [];
      const clients = [
        makeWindowClient(WORKBENCH_URL, {
          id: "origin-nonkeyed",
          visibilityState: "hidden",
          focusResult: { focused: true, visibilityState: "visible" },
          pageState: { focused: false, activeTaskId: "other" },
          onFocus: () => log.push("focus:0"),
          onMessage: (message) => log.push(`message:0:${(message as { type: string }).type}`),
        }),
        makeWindowClient(WORKBENCH_URL, {
          id: "tab-2",
          visibilityState: "hidden",
          pageState: { focused: false, activeTaskId: "t1" },
          onFocus: () => log.push("focus:1"),
          onMessage: (message) => log.push(`message:1:${(message as { type: string }).type}`),
        }),
      ];
      const worker = await loadWorker(clients);
      const channel = new MessageChannel();
      const reply = new Promise((resolve) => {
        channel.port1.onmessage = (event) => resolve(event.data);
      });
      await worker.dispatch("message", {
        data: taskRequest(),
        ports: [channel.port2],
        source: clients[0],
      });
      assert.deepEqual(plain(await reply), { shown: true, playSound: true });
      channel.port1.close();
      assert.equal(worker.calls.shown[0]?.options.data.originClientId, "origin-nonkeyed");

      // 隐藏窗口收到非 keyed 静默合并推送后，仍保留 originClientId；点击回到原发起页。
      await worker.dispatch("push", pushEvent(showPayload));
      assert.equal(worker.calls.shown.length, 2);
      assert.equal(worker.calls.shown[1]?.options.silent, true);
      assert.equal(worker.calls.shown[1]?.options.data.originClientId, "origin-nonkeyed");
      log.length = 0;
      await worker.dispatch("notificationclick", {
        notification: { close: () => {}, data: worker.calls.shown[1]?.options.data },
      });
      assert.deepEqual(log, ["focus:0", "message:0:zcode:notification-click"]);
      assert.deepEqual(worker.calls.opened, []);
    });

    it("marks keyed foreground-suppressed events as handled so late push after blur is skipped or silent", async () => {
      const caches = createFakeCaches();
      const turnKey = "zcode:event:turn:t1:5000";
      const tab1Foreground = makeWindowClient(WORKBENCH_URL, {
        id: "fg-tab",
        focused: true,
        visibilityState: "visible",
        pageState: { focused: true, activeTaskId: "t1" },
      });
      const worker = await loadWorker([tab1Foreground], undefined, caches);

      // 单页前台查看任务时，页面发送 zcode:mark-task-notification-handled 登记该 eventKey。
      await worker.dispatch("message", {
        data: {
          type: "zcode:mark-task-notification-handled",
          eventKey: turnKey,
          tag: "zcode:task:t1:terminal",
        },
        source: tab1Foreground,
      });

      // 失焦/隐藏后晚到的推送（userVisibleOnly 需展示）必须保持 silent 且 renotify=false。
      const tab1Hidden = makeWindowClient(WORKBENCH_URL, {
        id: "fg-tab",
        focused: false,
        visibilityState: "hidden",
        pageState: { focused: false, activeTaskId: "t1" },
      });
      const restarted = await loadWorker([tab1Hidden], undefined, caches);
      await restarted.dispatch("push", pushEvent({ ...showPayload, eventKey: turnKey }));
      assert.equal(restarted.calls.shown.length, 1);
      assert.equal(restarted.calls.shown[0]?.options.silent, true);
      assert.equal(restarted.calls.shown[0]?.options.renotify, false);

      // 若此时仍有可见同源窗口（Chromium 豁免），晚到推送直接跳过。
      const visibleWorker = await loadWorker(
        [
          makeWindowClient(WORKBENCH_URL, {
            id: "visible-other",
            visibilityState: "visible",
            pageState: { focused: true, activeTaskId: "other" },
          }),
        ],
        undefined,
        caches,
      );
      await visibleWorker.dispatch("push", pushEvent({ ...showPayload, eventKey: turnKey }));
      assert.equal(visibleWorker.calls.shown.length, 0);
    });

    it("does not duplicate page notification when active SW accepts postMessage but times out", async () => {
      const env = createEnv({ permission: "granted", existingSubscription: true });
      let sounds = 0;
      const controller = createWebNotificationController({
        pushEnabled: true,
        host: env.host,
        reconcileOnStart: false,
        playSound: () => void (sounds += 1),
      });
      const registration = await (
        env.host.navigator.serviceWorker as unknown as {
          getRegistration(): Promise<{ active: unknown; showNotification: () => Promise<void> }>;
        }
      ).getRegistration();
      // postMessage 成功交接但 SW 超时未回包：不得回退到本页展示或响铃。
      registration.active = { postMessage: () => {} };
      controller.showTaskNotification(payloadFor("task-a"));
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.equal(env.shown.length, 0);
      assert.equal(env.legacyNotifications.length, 0);
      assert.equal(sounds, 0);

      // postMessage 抛出未交接且 registration.showNotification 不可用时，保留 new Notification 回退。
      registration.active = {
        postMessage: () => {
          throw new Error("worker unavailable");
        },
      };
      registration.showNotification = async () => {
        throw new TypeError("not available");
      };
      controller.showTaskNotification(payloadFor("task-b"));
      await flush();
      assert.equal(env.legacyNotifications.length, 1);
      assert.equal(sounds, 1);
    });

    it("marks foreground-suppressed keyed notifications via active SW in controller", async () => {
      const env = createEnv({ permission: "granted", existingSubscription: true });
      env.setFocused(true);
      let sounds = 0;
      const controller = createWebNotificationController({
        pushEnabled: true,
        host: env.host,
        reconcileOnStart: false,
        playSound: () => void (sounds += 1),
      });
      const posted: unknown[] = [];
      const registration = await (
        env.host.navigator.serviceWorker as unknown as {
          getRegistration(): Promise<{ active: unknown }>;
        }
      ).getRegistration();
      registration.active = { postMessage: (message: unknown) => posted.push(message) };
      controller.syncActiveTaskSession("task-a");
      controller.showTaskNotification({
        ...payloadFor("task-a"),
        eventKey: "zcode:event:turn:task-a:1000",
      });
      await flush();
      assert.deepEqual(posted, [
        {
          type: "zcode:mark-task-notification-handled",
          eventKey: "zcode:event:turn:task-a:1000",
          tag: "zcode:task:task-a:terminal",
        },
      ]);
      assert.equal(env.shown.length, 0);
      assert.equal(sounds, 0);
    });

    it("routes a click on task B to tab 2, leaving tab 1 on task A untouched", async () => {
      const { tabs, worker, focusLog } = await openBrowser(2);
      const [tab1, tab2] = [tabs[0]!, tabs[1]!];
      tab1.controller.syncActiveTaskSession("task-a");
      tab2.controller.syncActiveTaskSession("task-b");
      await worker.dispatch("notificationclick", {
        notification: {
          close: () => {},
          data: { taskId: "task-b", workspacePath: "/repo" },
        },
      });
      assert.deepEqual(focusLog, [1]);
      assert.deepEqual(tab2.clicks, ["task-b"]);
      assert.deepEqual(tab1.clicks, []);
      assert.deepEqual(worker.calls.opened, []);
    });
  });
});
