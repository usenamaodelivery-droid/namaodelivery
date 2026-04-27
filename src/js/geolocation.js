// Background geolocation em Android (via @capacitor-community/background-geolocation)
// Fallback para navigator.geolocation quando rodando como web/PWA.
import { Capacitor } from "https://cdn.jsdelivr.net/npm/@capacitor/core@6/+esm";
import { updateDriverLocation } from "./orders.js";
import { LOCATION_UPDATE_MS } from "./firebaseConfig.js";

let tracking = false;
let watchId = null;
let intervalId = null;
let currentOrderId = null;
let lastSent = 0;

async function getBackgroundPlugin() {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const mod = await import("https://cdn.jsdelivr.net/npm/@capacitor-community/background-geolocation@1/+esm");
    return mod.BackgroundGeolocation;
  } catch (e) {
    console.warn("Background geolocation plugin indisponível", e);
    return null;
  }
}

export async function startTracking(orderId) {
  if (tracking) return;
  tracking = true;
  currentOrderId = orderId;
  lastSent = 0;

  const bg = await getBackgroundPlugin();
  if (bg) {
    // Plugin nativo: rodando mesmo em background / tela bloqueada
    watchId = await bg.addWatcher(
      {
        backgroundMessage: "NaMão está usando sua localização",
        backgroundTitle: "Entrega em andamento",
        requestPermissions: true,
        stale: false,
        distanceFilter: 20
      },
      (location, error) => {
        if (error) { console.error(error); return; }
        throttledSend(location.latitude, location.longitude);
      }
    );
  } else if (navigator.geolocation) {
    // Fallback web
    intervalId = setInterval(() => {
      navigator.geolocation.getCurrentPosition(
        (p) => throttledSend(p.coords.latitude, p.coords.longitude),
        (e) => console.warn("geo fallback error", e),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
      );
    }, LOCATION_UPDATE_MS);
  }
}

async function throttledSend(lat, lng) {
  const now = Date.now();
  if (now - lastSent < LOCATION_UPDATE_MS) return;
  lastSent = now;
  try {
    await updateDriverLocation(currentOrderId, lat, lng);
  } catch (err) {
    console.error("Falha ao atualizar localização:", err);
  }
}

export async function stopTracking() {
  if (!tracking) return;
  const bg = await getBackgroundPlugin();
  if (bg && watchId) {
    await bg.removeWatcher({ id: watchId });
    watchId = null;
  }
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
  tracking = false;
  currentOrderId = null;
}
