// Background geolocation em Android (via @capacitor-community/background-geolocation)
// Fallback para navigator.geolocation quando rodando como web/PWA.
import { Capacitor } from "https://cdn.jsdelivr.net/npm/@capacitor/core@6/+esm";
import { updateDriverLocation } from "./orders.js";
import { LOCATION_UPDATE_MS } from "./firebaseConfig.js";
import { updateDriverPosition } from "./maps.js";

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
  // Se já está rastreando outra corrida, reseta — durante o teste a gente
  // viu o plugin enviar uma localização e depois ficar mudo, e ninguém
  // chama stopTracking, então o flag `tracking` segurava o re-attach.
  if (tracking && currentOrderId !== orderId) {
    await stopTracking();
  }
  if (tracking) return;
  tracking = true;
  currentOrderId = orderId;
  lastSent = 0;

  const bg = await getBackgroundPlugin();
  if (bg) {
    // Plugin nativo: rodando mesmo em background / tela bloqueada.
    // distanceFilter 0 = recebe TODO update do GPS; o throttle abaixo
    // garante que só salvamos no Firestore a cada LOCATION_UPDATE_MS.
    try {
      watchId = await bg.addWatcher(
        {
          backgroundMessage: "NaMão está usando sua localização",
          backgroundTitle: "Entrega em andamento",
          requestPermissions: true,
          stale: false,
          distanceFilter: 0
        },
        (location, error) => {
          if (error) { console.error("[geo] watcher error", error); return; }
          if (location && typeof location.latitude === "number") {
            throttledSend(location.latitude, location.longitude);
          }
        }
      );
    } catch (e) {
      console.error("[geo] bg addWatcher failed", e);
    }
  }

  // SEMPRE rodamos o fallback navigator.geolocation por baixo, mesmo em
  // nativo. Garante atualização periódica caso o plugin nativo deixe de
  // enviar (Android suspende sensores em algumas situações).
  if (navigator.geolocation) {
    intervalId = setInterval(() => {
      navigator.geolocation.getCurrentPosition(
        (p) => throttledSend(p.coords.latitude, p.coords.longitude),
        (e) => console.warn("[geo] fallback error", e),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
      );
    }, LOCATION_UPDATE_MS);
  }
}

async function throttledSend(lat, lng) {
  // Atualiza visualmente o marker do motorista no mapa imediatamente
  try { updateDriverPosition(lat, lng); } catch { /* ignore */ }

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
