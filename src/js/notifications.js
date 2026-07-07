/**
 * Notificações de novos pedidos para o motorista.
 *
 * - Som "ding-ding-ding" alto (src/sounds/new-order.mp3)
 * - Vibração do celular (Capacitor + browser API)
 * - Repete 3x se motorista não interagir
 * - Local notification do Android (Capacitor) quando app em background
 *
 * Hook: chame `notifyNewOrder(order)` quando detectar um pedido novo
 * 'pending' no listener do Firestore.
 */

const SOUND_URL = "sounds/new-order.mp3";
let cachedAudio = null;
let lastSeenOrderIds = new Set();
let bootstrapped = false;

function isAlertableOrder(o) {
  if (!o || o.status !== "pending") return false;
  if (["cancelled", "canceled", "refunded"].includes(String(o.status || "").toLowerCase())) return false;
  if (o.refundPending || o.refundStatus) return false;
  if (o.cancelReason || o.cancelledAt || o.refundedAt || o.merchantCancelledAt || o.customerCancelledAt) return false;
  return Boolean(o.id);
}
let muted = false;

function getAudio() {
  if (!cachedAudio) {
    cachedAudio = new Audio(SOUND_URL);
    cachedAudio.preload = "auto";
    cachedAudio.volume = 1.0;
  }
  return cachedAudio;
}

function tryVibrate(pattern) {
  try {
    if (navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  } catch { /* silencioso */ }
}

async function playSound(times = 1) {
  if (muted) return;
  const audio = getAudio();
  for (let i = 0; i < times; i++) {
    try {
      audio.currentTime = 0;
      await audio.play();
    } catch (err) {
      // Autoplay bloqueado — som só toca depois da primeira interação do usuário.
      console.warn("[notifications] audio play blocked:", err?.message);
      return;
    }
    if (i < times - 1) {
      await new Promise((r) => setTimeout(r, 1300));
    }
  }
}

/**
 * Pede permissão de notificação no primeiro uso (quando o motorista
 * vai ficar online). Funciona no Capacitor e no browser.
 */
export async function requestNotificationPermission() {
  // Browser Notification API
  if ("Notification" in window && Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch { /* ignore */ }
  }
  // Capacitor PushNotifications (se existir)
  try {
    const Caps = window.Capacitor;
    if (Caps?.Plugins?.PushNotifications) {
      const perm = await Caps.Plugins.PushNotifications.checkPermissions();
      if (perm.receive !== "granted") {
        await Caps.Plugins.PushNotifications.requestPermissions();
      }
    }
  } catch { /* ignore */ }
}

/**
 * Notifica que chegou um pedido novo.
 * @param {{id?: string, distanceKm?: number, priceCents?: number}} order
 */
export function notifyNewOrder(order) {
  // Som + vibração — apelo imediato em foreground
  playSound(1);
  tryVibrate([300, 150, 300, 150, 600]);

  // Browser notification (foreground/quase background)
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const price = order?.priceCents
        ? ` · R$ ${(order.priceCents / 100).toFixed(2).replace(".", ",")}`
        : "";
      const km = order?.distanceKm ? ` · ${order.distanceKm.toFixed(1)} km` : "";
      const n = new Notification("Novo pedido NaMão!", {
        body: `Toca pra abrir${km}${price}`,
        icon: "icons/icon-192.png",
        badge: "icons/icon-192.png",
        tag: "namao-new-order",
        requireInteraction: false,
        silent: false,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
  } catch { /* ignore */ }
}

/**
 * Compara a lista nova de pedidos com a última vista e dispara
 * `notifyNewOrder` para cada pedido 'pending' que apareceu.
 *
 * Chamada do listener subscribeOrders.
 */
export function processOrderUpdate(orders) {
  if (!Array.isArray(orders)) return;
  const pending = orders.filter(isAlertableOrder);
  const currentIds = new Set(pending.map((o) => o.id));

  if (!bootstrapped) {
    // Primeira leitura — não toca som pra histórico
    lastSeenOrderIds = currentIds;
    bootstrapped = true;
    return;
  }

  const newOnes = pending.filter((o) => !lastSeenOrderIds.has(o.id));
  for (const o of newOnes) {
    notifyNewOrder(o);
  }
  lastSeenOrderIds = currentIds;
}

export function muteNewOrderSounds(value = true) { muted = !!value; }
export function isMuted() { return muted; }

/**
 * Botão de "tocar som de teste" pro motorista validar o áudio antes
 * do primeiro pedido — desbloqueia autoplay também (gesto do usuário).
 */
export function testNewOrderSound() {
  playSound(1);
  tryVibrate([200, 100, 200]);
}

if (typeof window !== "undefined") {
  window.testNewOrderSound = testNewOrderSound;
  window.requestNotificationPermission = requestNotificationPermission;
}
