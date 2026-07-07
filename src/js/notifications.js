/**
 * Notificações de novos pedidos para o motorista.
 *
 * - Som "alerta" alto (sounds/new-order.mp3) — TOCA EM LOOP até o motorista
 *   acessar o pedido ou tocar o botão "silenciar".
 * - Som curto pra mensagem nova do cliente (sounds/new-message.mp3).
 * - Vibração do celular contínua durante alerta.
 * - Local notification do Android (Capacitor) quando app em background via FCM.
 * - WakeLock — mantém tela ligada durante alerta.
 *
 * Hook: chame `notifyNewOrder(order)` quando detectar um pedido novo
 * 'pending' no listener do Firestore.
 */

const ORDER_SOUND_URL = "sounds/new-order.mp3";
const MESSAGE_SOUND_URL = "sounds/new-message.mp3";
let orderAudio = null;
let messageAudio = null;
let lastSeenOrderIds = new Set();
let bootstrapped = false;
let muted = false;
let alertActive = false;
let alertLoopId = null;
let alertVibrateId = null;
let wakeLock = null;

function getOrderAudio() {
  if (!orderAudio) {
    orderAudio = new Audio(ORDER_SOUND_URL);
    orderAudio.preload = "auto";
    orderAudio.volume = 1.0;
    orderAudio.loop = false; // Loop manual pra controlar intervalo
  }
  return orderAudio;
}

function getMessageAudio() {
  if (!messageAudio) {
    messageAudio = new Audio(MESSAGE_SOUND_URL);
    messageAudio.preload = "auto";
    messageAudio.volume = 1.0;
  }
  return messageAudio;
}

function tryVibrate(pattern) {
  try {
    if (navigator.vibrate) {
      navigator.vibrate(pattern);
    }
  } catch { /* silencioso */ }
}

async function tryWakeLock() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener?.("release", () => { wakeLock = null; });
    }
  } catch { /* sem wakelock, segue */ }
}

function releaseWakeLock() {
  try { wakeLock?.release?.(); } catch { /* ignore */ }
  wakeLock = null;
}

async function playOnce(audio) {
  if (muted) return;
  try {
    audio.currentTime = 0;
    await audio.play();
  } catch (err) {
    // Autoplay bloqueado — som só toca depois da primeira interação do usuário.
    console.warn("[notifications] audio play blocked:", err?.message);
  }
}

/** Inicia o alerta de novo pedido em LOOP até `stopOrderAlert()`. */
function startOrderAlert() {
  if (alertActive) return;
  alertActive = true;
  const audio = getOrderAudio();
  // Toca imediatamente
  playOnce(audio);
  // Vibração contínua via API: pattern repete enquanto vibrar não for chamado novamente
  // Padrão agressivo: 0.6s vibra, 0.3s pausa, repete
  alertVibrateId = setInterval(() => {
    tryVibrate([600, 300, 600, 300, 600, 300]);
  }, 2400);
  // Repete o som a cada ~2s (o áudio em si é ~1.5s)
  alertLoopId = setInterval(() => {
    if (!alertActive) return;
    playOnce(audio);
  }, 2000);
  tryWakeLock();
}

/** Para o alerta de novo pedido (chamado quando motorista toca em aceitar/dispensar). */
export function stopOrderAlert() {
  alertActive = false;
  if (alertLoopId) { clearInterval(alertLoopId); alertLoopId = null; }
  if (alertVibrateId) { clearInterval(alertVibrateId); alertVibrateId = null; }
  try {
    if (orderAudio) { orderAudio.pause(); orderAudio.currentTime = 0; }
  } catch { /* ignore */ }
  try { navigator.vibrate && navigator.vibrate(0); } catch { /* ignore */ }
  releaseWakeLock();
}

/** Toca som de mensagem nova (não loop). */
export function playMessageSound() {
  if (muted) return;
  const audio = getMessageAudio();
  playOnce(audio);
  tryVibrate([80, 50, 80]);
}

const ORDER_CHANNEL_ID = "namao_orders_v2";
const MESSAGE_CHANNEL_ID = "namao_messages_v2";

let fcmListenersBound = false;
let fcmTokenCb = null;
let broadcastCb = null;
let localNotifId = 4000;

/**
 * Mostra uma notificação NA BARRA de status mesmo com o app ABERTO (foreground).
 * O Android só monta a notificação automática quando o app está em background;
 * em foreground o push chega via `pushNotificationReceived` e nada aparece na
 * barra — só tocava o som. Aqui usamos LocalNotifications pra montar na barra.
 */
async function showTrayNotification({ title, body, channelId }) {
  try {
    const LN = window.Capacitor?.Plugins?.LocalNotifications;
    if (!LN) return; // Browser/PWA: sem plugin nativo, ignora (Web Notification cobre).
    localNotifId = (localNotifId + 1) % 2000000000;
    await LN.schedule({
      notifications: [
        {
          id: localNotifId,
          title: title || "NaMão",
          body: body || "",
          channelId: channelId || MESSAGE_CHANNEL_ID,
        },
      ],
    });
  } catch (err) {
    console.warn("[localnotif] schedule failed:", err);
  }
}

export function onFcmToken(cb) { fcmTokenCb = cb; }
export function onBroadcastPush(cb) { broadcastCb = cb; }

function bindFcmListeners() {
  if (fcmListenersBound) return;
  const Caps = window.Capacitor;
  const PN = Caps?.Plugins?.PushNotifications;
  if (!PN) return;
  fcmListenersBound = true;
  PN.addListener("registration", (token) => {
    const value = token?.value || token;
    if (typeof value === "string" && value.length > 10 && fcmTokenCb) {
      try { fcmTokenCb(value); } catch (err) { console.warn("[fcm] token cb threw:", err); }
    }
  });
  PN.addListener("registrationError", (err) => {
    console.warn("[fcm] registrationError:", err);
  });
  PN.addListener("pushNotificationReceived", (notif) => {
    // App em foreground recebe push — dispara o alerta in-app também
    const type = notif?.data?.type;
    if (type === "new_message") {
      playMessageSound();
      showTrayNotification({
        title: notif?.title || notif?.data?.title || "Nova mensagem",
        body: notif?.body || notif?.data?.body || "Você recebeu uma mensagem",
        channelId: MESSAGE_CHANNEL_ID,
      });
    } else if (type === "broadcast") {
      // Comunicado: NÃO toca sirene de pedido. Mostra modal in-app + bipe curto.
      try {
        playMessageSound();
      } catch { /* ignore */ }
      showTrayNotification({
        title: notif?.title || notif?.data?.title || "Comunicado NaMão",
        body: notif?.body || notif?.data?.body || "",
        channelId: MESSAGE_CHANNEL_ID,
      });
      if (broadcastCb) {
        try {
          broadcastCb({
            id: notif?.data?.broadcastId,
            title: notif?.data?.title || notif?.title || "Comunicado NaMão",
            message: notif?.data?.body || notif?.body || "",
          });
        } catch (err) { console.warn("[broadcast] cb threw:", err); }
      }
    } else {
      // Default: tratar como novo pedido
      showTrayNotification({
        title: notif?.title || "Novo pedido disponível",
        body: notif?.body || notif?.data?.body || "Abra o app pra aceitar",
        channelId: ORDER_CHANNEL_ID,
      });
      notifyNewOrder({
        id: notif?.data?.orderId,
        priceCents: notif?.data?.price ? Math.round(parseFloat(notif.data.price) * 100) : undefined,
        distanceKm: notif?.data?.distanceKm ? parseFloat(notif.data.distanceKm) : undefined,
      });
    }
  });
}

export async function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch { /* ignore */ }
  }
  try {
    const Caps = window.Capacitor;
    const PN = Caps?.Plugins?.PushNotifications;
    if (!PN) return;
    bindFcmListeners();
    let perm = await PN.checkPermissions();
    if (perm.receive !== "granted") {
      perm = await PN.requestPermissions();
    }
    if (perm.receive === "granted") {
      await PN.register();
    }
    // Garante permissão de LocalNotifications (mesma POST_NOTIFICATIONS no Android 13+)
    // pra conseguir montar a notificação na barra em foreground.
    try {
      const LN = Caps?.Plugins?.LocalNotifications;
      if (LN) {
        const lp = await LN.checkPermissions();
        if (lp.display !== "granted") await LN.requestPermissions();
      }
    } catch { /* ignore */ }
  } catch (err) { console.warn("[fcm] requestPermission failed:", err); }
}

/**
 * Notifica chegada de pedido novo. Inicia LOOP de som + vibração.
 * Chama `stopOrderAlert()` quando motorista aceitar/dispensar.
 */
export function notifyNewOrder(order) {
  startOrderAlert();

  // Browser notification (foreground/quase background)
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const price = order?.priceCents
        ? ` · R$ ${(order.priceCents / 100).toFixed(2).replace(".", ",")}`
        : "";
      const km = order?.distanceKm ? ` · ${order.distanceKm.toFixed(1)} km` : "";
      const n = new Notification("🛵 Novo pedido NaMão!", {
        body: `Abra o app pra aceitar${km}${price}`,
        icon: "icons/icon-192.png",
        badge: "icons/icon-192.png",
        tag: "namao-new-order",
        requireInteraction: true,
        silent: false,
      });
      n.onclick = () => {
        window.focus();
        stopOrderAlert();
        n.close();
      };
    }
  } catch { /* ignore */ }
}

/**
 * Compara a lista nova de pedidos com a última vista e dispara
 * `notifyNewOrder` para cada pedido 'pending' que apareceu.
 */
export function processOrderUpdate(orders) {
  if (!Array.isArray(orders)) return;
  const pending = orders.filter(
    (o) =>
      o?.status === "pending" &&
      o?.id &&
      !o.refundPending &&
      !o.refundStatus &&
      !o.cancelReason &&
      !o.cancelledAt &&
      !o.refundedAt &&
      !o.merchantCancelledAt &&
      !o.customerCancelledAt,
  );
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

  // Se todos os pedidos pendentes sumiram (foram aceitos/cancelados), para o alerta
  if (alertActive && currentIds.size === 0) {
    stopOrderAlert();
  }

  lastSeenOrderIds = currentIds;
}

export function muteNewOrderSounds(value = true) { muted = !!value; }
export function isMuted() { return muted; }

/**
 * Botão de "tocar som de teste" pro motorista validar o áudio antes
 * do primeiro pedido — desbloqueia autoplay também (gesto do usuário).
 * Toca uma vez (sem loop) pra ele ouvir.
 */
export function testNewOrderSound() {
  const audio = getOrderAudio();
  playOnce(audio);
  tryVibrate([300, 150, 300]);
}

if (typeof window !== "undefined") {
  window.testNewOrderSound = testNewOrderSound;
  window.requestNotificationPermission = requestNotificationPermission;
  window.stopOrderAlert = stopOrderAlert;
}
