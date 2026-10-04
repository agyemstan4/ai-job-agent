// Phone notifications — FOUNDATION ONLY (Phase 4a). Nothing here sends a
// notification, asks the browser for permission, subscribes to push or
// contacts any provider. It defines what a user can choose to be told about
// and remembers those choices on this device (a push subscription is
// per-device anyway). A later checkpoint will add delivery (and, if choices
// must follow the user between devices, a small table — not created yet).

/** Hard switch: no notification of any kind is delivered in this version. */
export const NOTIFICATIONS_DELIVERY_ENABLED = false;

export const NOTIFICATION_SETTINGS_KEY = "jobAgent.notificationSettings";

export const NOTIFICATION_TOPICS = [
  { id: "morningBrief", label: "Morning job brief", description: "When your daily brief of opportunities is ready.", defaultOn: true },
  { id: "standoutOpportunity", label: "New standout opportunities", description: "When a strong match with something you care about appears.", defaultOn: true },
  { id: "applicationReady", label: "Application ready to review", description: "When your agent has prepared an application for you.", defaultOn: true },
  { id: "applicationFollowUp", label: "Application follow-up", description: "A reminder to check on applications you have sent.", defaultOn: false },
] as const;

export type NotificationTopic = (typeof NOTIFICATION_TOPICS)[number]["id"];
export type NotificationSettings = Record<NotificationTopic, boolean>;

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = Object.fromEntries(
  NOTIFICATION_TOPICS.map((t) => [t.id, t.defaultOn])
) as NotificationSettings;

/** Stored settings, with anything missing or invalid replaced by the default. */
export function parseNotificationSettings(raw: unknown): NotificationSettings {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    NOTIFICATION_TOPICS.map((t) => [t.id, typeof value[t.id] === "boolean" ? value[t.id] : t.defaultOn])
  ) as NotificationSettings;
}

export function loadNotificationSettings(storage: Pick<Storage, "getItem"> | null): NotificationSettings {
  try {
    return parseNotificationSettings(JSON.parse(storage?.getItem(NOTIFICATION_SETTINGS_KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
}

export function saveNotificationSettings(storage: Pick<Storage, "setItem"> | null, settings: NotificationSettings): boolean {
  try {
    storage?.setItem(NOTIFICATION_SETTINGS_KEY, JSON.stringify(parseNotificationSettings(settings)));
    return Boolean(storage);
  } catch {
    return false;
  }
}

export type NotificationSupport = {
  /** The browser can show notifications at all. */
  notifications: boolean;
  serviceWorker: boolean;
  push: boolean;
  /** Current permission, read only — this code never asks for it. */
  permission: "granted" | "denied" | "default" | "unsupported";
  /** Opened from the home screen (installed). */
  installed: boolean;
};

/** What this browser could do later. Reads properties only; requests nothing. */
export function notificationSupport(win: unknown): NotificationSupport {
  const w = (win ?? {}) as {
    Notification?: { permission?: string };
    navigator?: { serviceWorker?: unknown; standalone?: boolean };
    PushManager?: unknown;
    matchMedia?: (query: string) => { matches: boolean };
  };
  const permission = w.Notification?.permission;
  return {
    notifications: Boolean(w.Notification),
    serviceWorker: Boolean(w.navigator && "serviceWorker" in w.navigator),
    push: Boolean(w.PushManager),
    permission: permission === "granted" || permission === "denied" || permission === "default" ? permission : "unsupported",
    installed: Boolean(w.navigator?.standalone) || Boolean(w.matchMedia?.("(display-mode: standalone)").matches),
  };
}
