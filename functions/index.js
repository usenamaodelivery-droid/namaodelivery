/**
 * Cloud Functions — admin, segurança & notificações.
 *
 * - setAdminClaim: callable. Apenas quem já é admin (ou — no primeiro boot —
 *   o e-mail em ADMIN_BOOTSTRAP_EMAIL) pode promover outro UID.
 * - onOrderCreated: dispara FCM pra todos os drivers aprovados quando um
 *   pedido entra em status `pending` (depois do PIX confirmado).
 * - onOrderStatusChanged: notifica o cliente quando status muda
 *   (accepted / in_transit / completed / cancelled).
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "southamerica-east1", maxInstances: 10 });

const APP_ID = "namao-delivery-prod";
const BOOTSTRAP_EMAIL = process.env.ADMIN_BOOTSTRAP_EMAIL || "";

exports.setAdminClaim = onCall(async (request) => {
  const { targetUid, admin: makeAdmin } = request.data || {};
  if (!targetUid) throw new HttpsError("invalid-argument", "targetUid obrigatório");

  const caller = request.auth;
  if (!caller) throw new HttpsError("unauthenticated", "Login obrigatório");

  const isBootstrap =
    BOOTSTRAP_EMAIL &&
    caller.token.email &&
    caller.token.email.toLowerCase() === BOOTSTRAP_EMAIL.toLowerCase();

  if (!caller.token.admin && !isBootstrap) {
    throw new HttpsError("permission-denied", "Apenas admins podem promover outros usuários");
  }

  await admin.auth().setCustomUserClaims(targetUid, { admin: Boolean(makeAdmin) });
  return { ok: true, targetUid, admin: Boolean(makeAdmin) };
});

/**
 * Dispara FCM pra todos os drivers aprovados quando um pedido entra em
 * `pending` (já passou pelo PIX). Idempotente: só dispara na transição.
 */
async function notifyAvailableDrivers(orderData, orderId) {
  // Pega todos approved e filtra na CPU — `!=` no Firestore exclui docs
  // sem o campo, e queremos default=true.
  const profilesSnap = await admin
    .firestore()
    .collectionGroup("profile")
    .where("status", "==", "approved")
    .get();

  const tokens = [];
  profilesSnap.forEach((doc) => {
    if (doc.get("notifyOnNewOrder") === false) return;
    const t = doc.get("fcmToken");
    if (typeof t === "string" && t.length > 10) tokens.push(t);
  });
  if (!tokens.length) return;

  const veh = orderData.veh || "Moto";
  const price = typeof orderData.price === "number" ? orderData.price.toFixed(2) : "?";
  const distance = typeof orderData.distanceKm === "number" ? orderData.distanceKm.toFixed(1) : "?";

  await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title: "Novo pedido disponível",
      body: `${veh} · R$ ${price} · ${distance} km`,
    },
    android: {
      priority: "high",
      notification: {
        channelId: "namao_orders",
        sound: "default",
        vibrateTimingsMillis: [0, 300, 200, 300],
        defaultLightSettings: true,
      },
    },
    data: {
      type: "new_order",
      orderId: String(orderId),
    },
  });
}

exports.onOrderCreated = onDocumentCreated(
  `artifacts/${APP_ID}/public/data/orders/{orderId}`,
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    if (data.status !== "pending") return; // só dispara se já entrou direto em pending
    await notifyAvailableDrivers(data, event.params.orderId);
  }
);

exports.onOrderStatusChanged = onDocumentUpdated(
  `artifacts/${APP_ID}/public/data/orders/{orderId}`,
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    if (before.status === after.status) return;

    // waiting_confirmation -> pending: PIX confirmado, notifica drivers
    if (before.status === "waiting_confirmation" && after.status === "pending") {
      await notifyAvailableDrivers(after, event.params.orderId);
    }

    // Notifica o cliente nas transições principais (precisa de customerFcmToken)
    const customerToken = after.customerFcmToken;
    if (typeof customerToken !== "string" || customerToken.length < 10) return;

    const messages = {
      accepted: { title: "Motorista a caminho", body: `${after.driverName || "Motoboy"} aceitou seu pedido.` },
      in_transit: { title: "Pedido coletado", body: "Seu pedido foi coletado e está a caminho." },
      completed: { title: "Pedido entregue!", body: "Obrigado por usar o Delivery NaMão." },
      cancelled: { title: "Pedido cancelado", body: "Seu pedido foi cancelado." },
    };
    const msg = messages[after.status];
    if (!msg) return;

    await admin.messaging().send({
      token: customerToken,
      notification: msg,
      data: { type: "order_update", orderId: String(event.params.orderId), status: after.status },
    });
  }
);
