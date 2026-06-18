// Wrapper unificado das permissões nativas (Android via Capacitor) e do browser.
// Cada handler retorna 'granted' | 'denied' | 'prompt' | 'unavailable'.
import { Capacitor } from "https://cdn.jsdelivr.net/npm/@capacitor/core@6/+esm";

const STATUS_LABEL = {
  granted: { txt: "ATIVO", cls: "bg-green-100 text-success" },
  denied: { txt: "BLOQUEADO", cls: "bg-red-100 text-danger" },
  prompt: { txt: "PEDIR", cls: "bg-amber-100 text-amber-700" },
  unavailable: { txt: "—", cls: "bg-gray-100 text-gray-500" },
};

function paint(elId, status) {
  const el = document.getElementById(elId);
  if (!el) return;
  const meta = STATUS_LABEL[status] || STATUS_LABEL.unavailable;
  el.textContent = meta.txt;
  el.className = `text-xs font-extrabold uppercase tracking-wider px-3 py-1 rounded-full ${meta.cls}`;
}

async function checkNotifications() {
  try {
    const Caps = window.Capacitor;
    const PN = Caps?.Plugins?.PushNotifications;
    if (PN) {
      const r = await PN.checkPermissions();
      if (r.receive === "granted") return "granted";
      if (r.receive === "denied") return "denied";
      return "prompt";
    }
    if ("Notification" in window) {
      const p = Notification.permission;
      if (p === "granted") return "granted";
      if (p === "denied") return "denied";
      return "prompt";
    }
  } catch { /* ignore */ }
  return "unavailable";
}

async function requestNotifications() {
  try {
    const Caps = window.Capacitor;
    const PN = Caps?.Plugins?.PushNotifications;
    if (PN) {
      const r = await PN.requestPermissions();
      if (r.receive === "granted") {
        try { await PN.register(); } catch { /* ignore */ }
        return "granted";
      }
      return r.receive === "denied" ? "denied" : "prompt";
    }
    if ("Notification" in window) {
      const p = await Notification.requestPermission();
      return p === "granted" ? "granted" : (p === "denied" ? "denied" : "prompt");
    }
  } catch { /* ignore */ }
  return "unavailable";
}

async function checkLocation() {
  try {
    if (Capacitor.isNativePlatform()) {
      const mod = await import("https://cdn.jsdelivr.net/npm/@capacitor/geolocation@8/+esm");
      const r = await mod.Geolocation.checkPermissions();
      const v = r.location || r.coarseLocation;
      if (v === "granted") return "granted";
      if (v === "denied") return "denied";
      return "prompt";
    }
    if (navigator.permissions) {
      const r = await navigator.permissions.query({ name: "geolocation" });
      return r.state === "granted" ? "granted" : (r.state === "denied" ? "denied" : "prompt");
    }
  } catch { /* ignore */ }
  return "unavailable";
}

async function requestLocation() {
  try {
    if (Capacitor.isNativePlatform()) {
      const mod = await import("https://cdn.jsdelivr.net/npm/@capacitor/geolocation@8/+esm");
      const r = await mod.Geolocation.requestPermissions();
      const v = r.location || r.coarseLocation;
      if (v === "granted") return "granted";
      return v === "denied" ? "denied" : "prompt";
    }
    if (navigator.geolocation) {
      return await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          () => resolve("granted"),
          (err) => resolve(err.code === 1 ? "denied" : "prompt"),
          { timeout: 8000 }
        );
      });
    }
  } catch { /* ignore */ }
  return "unavailable";
}

async function checkCamera() {
  try {
    if (Capacitor.isNativePlatform()) {
      const mod = await import("https://cdn.jsdelivr.net/npm/@capacitor/camera@8/+esm");
      const r = await mod.Camera.checkPermissions();
      const v = r.camera;
      if (v === "granted") return "granted";
      if (v === "denied") return "denied";
      return "prompt";
    }
    if (navigator.permissions) {
      try {
        const r = await navigator.permissions.query({ name: "camera" });
        return r.state === "granted" ? "granted" : (r.state === "denied" ? "denied" : "prompt");
      } catch { return "prompt"; }
    }
  } catch { /* ignore */ }
  return "unavailable";
}

async function requestCamera() {
  try {
    if (Capacitor.isNativePlatform()) {
      const mod = await import("https://cdn.jsdelivr.net/npm/@capacitor/camera@8/+esm");
      const r = await mod.Camera.requestPermissions({ permissions: ["camera", "photos"] });
      const v = r.camera;
      if (v === "granted") return "granted";
      return v === "denied" ? "denied" : "prompt";
    }
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => t.stop());
        return "granted";
      } catch (err) {
        return err?.name === "NotAllowedError" ? "denied" : "prompt";
      }
    }
  } catch { /* ignore */ }
  return "unavailable";
}

const HANDLERS = {
  notifications: { check: checkNotifications, request: requestNotifications, elId: "perm-notifications-status" },
  location: { check: checkLocation, request: requestLocation, elId: "perm-location-status" },
  camera: { check: checkCamera, request: requestCamera, elId: "perm-camera-status" },
};

export async function refreshPermissionStatuses() {
  for (const [, h] of Object.entries(HANDLERS)) {
    const status = await h.check();
    paint(h.elId, status);
  }
}

export async function requestAppPermission(kind) {
  const h = HANDLERS[kind];
  if (!h) return;
  paint(h.elId, "prompt");
  const status = await h.request();
  paint(h.elId, status);
  return status;
}

if (typeof window !== "undefined") {
  window.requestAppPermission = requestAppPermission;
  window.refreshPermissionStatuses = refreshPermissionStatuses;
}
