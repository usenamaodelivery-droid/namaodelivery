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
const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "southamerica-east1", maxInstances: 10 });

const APP_ID = "namao-delivery-prod";
const BOOTSTRAP_EMAIL = process.env.ADMIN_BOOTSTRAP_EMAIL || "";
const PLATFORM_FEE = 0.15; // 15% fica com a empresa, 85% repassa pro motorista
const DRIVER_SHARE = 1 - PLATFORM_FEE;

// Frete (entrega) do pedido, em centavos. Pedido de loja (Pedir NaMão) carrega
// deliveryPriceCents separado do subtotal dos produtos — o motorista só ganha
// sobre o frete, nunca sobre o produto (que é do lojista). Pedido ponto-a-ponto
// não tem produto, então `price` já é o próprio frete.
function orderFreteCents(o) {
  if (o && o.deliveryPriceCents != null) return Math.round(Number(o.deliveryPriceCents));
  return Math.round((Number(o && o.price) || 0) * 100);
}

// Ganho do motorista em centavos (85% do frete). Prefere o valor já gravado no
// pedido (driverEarnings) quando existir, pra manter consistência histórica.
function driverEarnCents(o) {
  if (o && o.driverEarnings != null) return Math.round(Number(o.driverEarnings) * 100);
  return Math.round(orderFreteCents(o) * DRIVER_SHARE);
}

// Mercado Pago — secrets armazenados via `firebase functions:secrets:set`
const MP_ACCESS_TOKEN_SECRET = defineSecret("MERCADOPAGO_ACCESS_TOKEN");
const MP_WEBHOOK_SECRET = defineSecret("MERCADOPAGO_WEBHOOK_SECRET");

// VAPID — Web Push pro mini-admin do lojista (PWA). A pública também roda
// no front, mas a privada só aqui.
const VAPID_PUBLIC_KEY_SECRET = defineSecret("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE_KEY_SECRET = defineSecret("VAPID_PRIVATE_KEY");
const VAPID_SUBJECT_SECRET = defineSecret("VAPID_SUBJECT");

function getMpToken() {
  return MP_ACCESS_TOKEN_SECRET.value() || process.env.MERCADOPAGO_ACCESS_TOKEN || "";
}

// Token Mercado Pago do LOJISTA (split de pagamento). Pedido de loja é criado
// com o token do próprio lojista (ele é o collector), então o estorno também
// precisa ser feito com o token dele — o token da plataforma não consegue
// estornar um pagamento de outra conta. Os tokens ficam num caminho privado
// gravado pelo PWA (namao-pwa) no mesmo projeto Firestore.
async function getSellerMpToken(storeId) {
  if (!storeId) return null;
  try {
    const snap = await admin
      .firestore()
      .doc(`artifacts/${APP_ID}/private/data/merchant_mp/${storeId}`)
      .get();
    if (!snap.exists) return null;
    const d = snap.data() || {};
    return d.accessToken ? String(d.accessToken) : null;
  } catch (e) {
    console.error("[refund] erro lendo token do lojista:", e);
    return null;
  }
}

// Escolhe o token certo pro estorno de um pedido: lojista (split) ou plataforma.
async function refundTokenForOrder(orderData) {
  if (orderData && orderData.splitApplied) {
    const sellerToken = await getSellerMpToken(orderData.storeId);
    if (sellerToken) return sellerToken;
  }
  return getMpToken();
}

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

// --- Dispatch por proximidade ---------------------------------------------
// O pedido NÃO vai pra todo motorista do mundo. Notifica primeiro quem está
// mais perto do ponto de coleta; se ninguém pega, o raio cresce a cada ciclo
// (re-toca) até o máximo. Motorista só recebe se estiver a no máx. 30 km.
const DISPATCH_FIRST_RADIUS_KM = 15; // primeiro toque: já cobre a cidade toda (sem atraso)
const DISPATCH_STEP_KM = 8; // cresce o raio a cada re-toque
const DISPATCH_MAX_RADIUS_KM = 30; // teto absoluto (regra do dono)
const DISPATCH_RERING_MS = 2 * 60 * 1000; // re-toca a cada 2 min se ninguém pegar
const DISPATCH_GIVEUP_MS = 30 * 60 * 1000; // para de re-tocar depois de 30 min
const DRIVER_LOCATION_FRESH_MS = 30 * 60 * 1000; // só conta quem mandou GPS nos últimos 30 min

function toRad(d) { return (d * Math.PI) / 180; }
function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Coordenada do ponto de COLETA do pedido (loja / origem).
function pickupCoordsOf(o) {
  if (o && o.originCoords && typeof o.originCoords.lat === "number") {
    return { lat: o.originCoords.lat, lng: o.originCoords.lng };
  }
  if (o && typeof o.storeLat === "number" && typeof o.storeLng === "number") {
    return { lat: o.storeLat, lng: o.storeLng };
  }
  return null;
}

/**
 * Notifica os motoristas aprovados, ONLINE e DENTRO de `radiusKm` do ponto de
 * coleta. Retorna quantos foram notificados. Se o pedido não tiver coordenada
 * de coleta (dado legado), cai no fallback de notificar todos (pra nunca deixar
 * de despachar por falta de dado).
 */
async function dispatchToDrivers(orderData, orderId, radiusKm) {
  const pickup = pickupCoordsOf(orderData);
  const profilesSnap = await admin
    .firestore()
    .collectionGroup("profile")
    .where("status", "==", "approved")
    .get();

  const now = Date.now();
  const nearTokens = [];
  const allTokens = [];
  profilesSnap.forEach((doc) => {
    if (doc.id !== "driverInfo") return;
    if (doc.get("notifyOnNewOrder") === false) return;
    const t = doc.get("fcmToken");
    if (typeof t !== "string" || t.length <= 10) return;
    allTokens.push(t);

    if (pickup) {
      const lat = doc.get("lastLat");
      const lng = doc.get("lastLng");
      const at = doc.get("lastLocationAt");
      if (typeof lat !== "number" || typeof lng !== "number") return;
      if (typeof at !== "number" || now - at > DRIVER_LOCATION_FRESH_MS) return;
      const dist = haversineKm(pickup.lat, pickup.lng, lat, lng);
      if (dist > radiusKm) return;
    }
    nearTokens.push(t);
  });

  // Prioriza quem está perto e com GPS recente. Mas se NINGUÉM se qualifica
  // (todos sem GPS recente, ou o motorista mais perto está logo além do raio),
  // manda pra TODOS os motoristas aprovados com token — melhor um motorista um
  // pouco mais longe receber do que o pedido não tocar em ninguém e ficar parado.
  const tokens = nearTokens.length ? nearTokens : allTokens;
  if (!tokens.length) return 0;

  const veh = orderData.veh || "Moto";
  const earn = (driverEarnCents(orderData) / 100).toFixed(2);
  const distance = typeof orderData.distanceKm === "number" ? orderData.distanceKm.toFixed(1) : "?";

  await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title: "Novo pedido disponível",
      body: `${veh} · Você ganha R$ ${earn} · ${distance} km`,
    },
    android: {
      priority: "high",
      notification: {
        channelId: "namao_orders_v2",
        sound: "new_order",
        vibrateTimingsMillis: [0, 600, 300, 600, 300, 600],
        defaultLightSettings: true,
      },
    },
    data: {
      type: "new_order",
      orderId: String(orderId),
    },
  });
  return tokens.length;
}

/**
 * Primeiro toque de um pedido novo em `pending`. Notifica só o raio inicial e
 * grava o estado de dispatch no pedido pro re-toque (scheduler) continuar.
 */
async function notifyAvailableDrivers(orderData, orderId) {
  const radius = DISPATCH_FIRST_RADIUS_KM;
  const sent = await dispatchToDrivers(orderData, orderId, radius);
  try {
    await admin
      .firestore()
      .doc(`artifacts/${APP_ID}/public/data/orders/${orderId}`)
      .update({
        dispatchRadiusKm: radius,
        dispatchStartedAt: Date.now(),
        lastDispatchAt: Date.now(),
        dispatchRounds: 1,
      });
  } catch (err) {
    console.warn(`[dispatch] falha ao gravar estado do pedido ${orderId}:`, err);
  }
  console.log(`[dispatch] pedido ${orderId}: 1º toque raio ${radius}km → ${sent} motorista(s)`);
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

/**
 * Re-toque: a cada minuto varre os pedidos ainda `pending` (ninguém pegou) e,
 * passados ~2 min do último toque, aumenta o raio e re-notifica (toca de novo).
 * Cresce até 30 km e desiste depois de 30 min. É isso que faz "tocou, ninguém
 * pegou, passa um tempo toca de novo" + "primeiro os mais perto, depois longe".
 */
exports.redispatchPendingOrders = onSchedule("every 1 minutes", async () => {
  const db = admin.firestore();
  const snap = await db
    .collection(`artifacts/${APP_ID}/public/data/orders`)
    .where("status", "==", "pending")
    .get();

  const now = Date.now();
  for (const docSnap of snap.docs) {
    const o = docSnap.data();
    if (o.driverId) continue; // já tem motorista
    const startedAt = o.dispatchStartedAt || o.pendingAt || o.createdAt || now;
    if (now - startedAt > DISPATCH_GIVEUP_MS) continue; // já passou da janela
    const lastAt = o.lastDispatchAt || 0;
    if (now - lastAt < DISPATCH_RERING_MS) continue; // ainda não é hora de re-tocar

    const prevRadius = typeof o.dispatchRadiusKm === "number" ? o.dispatchRadiusKm : DISPATCH_FIRST_RADIUS_KM;
    const radius = Math.min(DISPATCH_MAX_RADIUS_KM, prevRadius + DISPATCH_STEP_KM);
    const sent = await dispatchToDrivers(o, docSnap.id, radius);
    await docSnap.ref.update({
      dispatchRadiusKm: radius,
      lastDispatchAt: now,
      dispatchRounds: (o.dispatchRounds || 1) + 1,
    });
    console.log(`[dispatch] re-toque pedido ${docSnap.id}: raio ${radius}km → ${sent} motorista(s)`);
  }
});

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

    // Corrida cancelada/estornada: AVISA O MOTORISTA responsável. Sem isso ele
    // continuava indo buscar o pedido e só descobria que sumiu ao reabrir o app.
    // Manda push (acorda o celular mesmo com app fechado) + som/vibração.
    const CANCEL_STATES = ["cancelled", "refunded"];
    if (CANCEL_STATES.includes(after.status) && !CANCEL_STATES.includes(before.status)) {
      const driverId = before.driverId || after.driverId;
      if (driverId) {
        try {
          const dSnap = await admin
            .firestore()
            .doc(`artifacts/${APP_ID}/users/${driverId}/profile/driverInfo`)
            .get();
          const dToken = dSnap.exists ? dSnap.get("fcmToken") : null;
          if (typeof dToken === "string" && dToken.length > 10) {
            await admin.messaging().send({
              token: dToken,
              notification: {
                title: "Corrida cancelada",
                body: "A corrida foi cancelada. NÃO vá buscar o pedido.",
              },
              android: {
                priority: "high",
                notification: {
                  channelId: "namao_orders_v2",
                  sound: "new_order",
                  vibrateTimingsMillis: [0, 400, 200, 400, 200, 400],
                },
              },
              data: {
                type: "order_cancelled",
                orderId: String(event.params.orderId),
              },
            });
          }
        } catch (err) {
          console.warn("[fcm] cancel push pro motorista falhou:", err?.message);
        }
      }
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

/**
 * Quando o cliente envia mensagem no chat de um pedido, dispara FCM pro
 * motorista responsável (se houver). Sem isso, o app driver em background
 * não toca som de mensagem.
 */
exports.onChatMessageCreated = onDocumentCreated(
  `artifacts/${APP_ID}/public/data/orders/{orderId}/messages/{messageId}`,
  async (event) => {
    const msg = event.data?.data();
    if (!msg || msg.from !== "customer") return; // só notifica driver quando cliente fala

    const orderId = event.params.orderId;
    const orderSnap = await admin
      .firestore()
      .doc(`artifacts/${APP_ID}/public/data/orders/${orderId}`)
      .get();
    if (!orderSnap.exists) return;
    const order = orderSnap.data();
    const driverId = order.driverId;
    if (!driverId) return;

    const profileSnap = await admin
      .firestore()
      .doc(`artifacts/${APP_ID}/users/${driverId}/profile/driverInfo`)
      .get();
    const token = profileSnap.exists ? profileSnap.get("fcmToken") : null;
    if (typeof token !== "string" || token.length < 10) return;

    const preview = String(msg.text || "").slice(0, 80);
    try {
      await admin.messaging().send({
        token,
        notification: {
          title: `💬 ${order.customerName || "Cliente"}`,
          body: preview,
        },
        android: {
          priority: "high",
          notification: {
            channelId: "namao_messages_v2",
            sound: "new_message",
            vibrateTimingsMillis: [0, 100, 50, 100],
          },
        },
        data: {
          type: "new_message",
          orderId: String(orderId),
        },
      });
    } catch (err) {
      console.warn("[fcm] chat message push failed:", err?.message);
    }
  }
);

/* ===========================================================================
 * MERCADO PAGO — pagamentos do cliente + repasse PIX automático pro motorista
 * =========================================================================== */

/**
 * Webhook do Mercado Pago. Configurar URL no painel MP:
 *   https://us-central1-namao-delivery-prod.cloudfunctions.net/mercadopagoWebhook
 *   (ou region southamerica-east1 dependendo do deploy)
 *
 * Recebe notificações de payment + payout. Quando um pagamento PIX é
 * aprovado, atualiza o pedido pra status="pending" (libera pros motoristas).
 */
exports.mercadopagoWebhook = onRequest(
  { cors: false, invoker: "public", secrets: [MP_ACCESS_TOKEN_SECRET, MP_WEBHOOK_SECRET] },
  async (req, res) => {
  try {
    const type = req.body?.type || req.query?.type;
    const dataId = req.body?.data?.id || req.query?.["data.id"];
    if (!type || !dataId) {
      res.status(200).send("ok");
      return;
    }

    if (type === "payment") {
      const r = await fetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
        headers: { Authorization: `Bearer ${getMpToken()}` },
      });
      if (!r.ok) {
        console.error("MP payment fetch failed", r.status);
        res.status(200).send("ok");
        return;
      }
      const payment = await r.json();
      const orderId = payment.external_reference || payment.metadata?.order_id;
      if (!orderId) {
        res.status(200).send("ok");
        return;
      }
      const orderRef = admin
        .firestore()
        .doc(`artifacts/${APP_ID}/public/data/orders/${orderId}`);
      const before = (await orderRef.get()).data();
      if (!before) {
        res.status(200).send("ok");
        return;
      }
      const update = {
        paymentId: String(dataId),
        paymentStatus: payment.status,
        paymentStatusDetail: payment.status_detail,
        paymentAmount: payment.transaction_amount,
        paymentUpdatedAt: Date.now(),
      };
      if (payment.status === "approved" && before.status === "waiting_confirmation") {
        // Pedido de loja (catálogo) precisa de aceite do merchant ANTES de
        // qualquer motorista ser convocado. Sem storeId é entrega ponto-a-
        // ponto e segue o fluxo legado (PIX → pending → driver dispatch).
        if (before.storeId) {
          update.status = "awaiting_merchant_acceptance";
          update.merchantAcceptDeadline = Date.now() + 10 * 60 * 1000;
        } else {
          update.status = "pending"; // libera pros motoristas
        }
        update.paymentApprovedAt = Date.now();
      }
      if (payment.status === "refunded") {
        update.status = "refunded";
        update.refundedAt = Date.now();
      }
      await orderRef.update(update);
    }

    res.status(200).send("ok");
  } catch (e) {
    console.error("mercadopagoWebhook error", e);
    res.status(200).send("ok"); // sempre 200 pra MP não tentar mil vezes
  }
});

/**
 * Cliente cria/recupera o PIX QR Code de um pedido.
 * Chamado pelo PWA na criação do pedido. Cria o pagamento PIX no MP, salva
 * o paymentId no doc do pedido, e retorna o QR Code base64 + copia-cola.
 */
exports.createOrderPix = onCall({ secrets: [MP_ACCESS_TOKEN_SECRET] }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Login obrigatório");
  if (!getMpToken()) throw new HttpsError("failed-precondition", "MP token não configurado");

  const { orderId } = request.data || {};
  if (!orderId) throw new HttpsError("invalid-argument", "orderId obrigatório");

  const orderRef = admin.firestore().doc(`artifacts/${APP_ID}/public/data/orders/${orderId}`);
  const snap = await orderRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Pedido não encontrado");
  const order = snap.data();

  if (order.customerUid && order.customerUid !== auth.uid) {
    throw new HttpsError("permission-denied", "Pedido não é seu");
  }

  // Idempotente: se já existe paymentId, retorna o existente
  if (order.paymentId && order.paymentQrCode) {
    return {
      paymentId: order.paymentId,
      qrCode: order.paymentQrCode,
      qrCodeBase64: order.paymentQrCodeBase64,
      ticketUrl: order.paymentTicketUrl,
    };
  }

  const amount = Number(order.price);
  if (!amount || amount <= 0) throw new HttpsError("invalid-argument", "Pedido sem valor");

  const idempotencyKey = `order-${orderId}-${Date.now()}`;
  const r = await fetch("https://api.mercadopago.com/v1/payments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getMpToken()}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      transaction_amount: amount,
      description: `Delivery NaMão - Pedido ${orderId.slice(-6).toUpperCase()}`,
      payment_method_id: "pix",
      external_reference: orderId,
      metadata: { order_id: orderId },
      payer: {
        email: auth.token.email || `cliente-${auth.uid}@namaodelivery.com`,
        first_name: order.customerName || "Cliente",
      },
      notification_url: process.env.MP_WEBHOOK_URL || undefined,
    }),
  });

  const result = await r.json();
  if (!r.ok) {
    console.error("MP createPayment failed", r.status, result);
    throw new HttpsError("internal", `MP error: ${result.message || r.status}`);
  }

  const qrCode = result.point_of_interaction?.transaction_data?.qr_code;
  const qrCodeBase64 = result.point_of_interaction?.transaction_data?.qr_code_base64;
  const ticketUrl = result.point_of_interaction?.transaction_data?.ticket_url;

  await orderRef.update({
    paymentId: String(result.id),
    paymentStatus: result.status,
    paymentQrCode: qrCode || null,
    paymentQrCodeBase64: qrCodeBase64 || null,
    paymentTicketUrl: ticketUrl || null,
    paymentCreatedAt: Date.now(),
  });

  return {
    paymentId: String(result.id),
    qrCode,
    qrCodeBase64,
    ticketUrl,
  };
});

/**
 * Cliente cancela um pedido não-aceito e recebe estorno.
 * Só funciona se o pedido ainda não foi aceito por um motorista.
 */
exports.refundOrder = onCall({ secrets: [MP_ACCESS_TOKEN_SECRET] }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Login obrigatório");
  if (!getMpToken()) throw new HttpsError("failed-precondition", "MP token não configurado");

  const { orderId } = request.data || {};
  if (!orderId) throw new HttpsError("invalid-argument", "orderId obrigatório");

  const orderRef = admin.firestore().doc(`artifacts/${APP_ID}/public/data/orders/${orderId}`);
  const snap = await orderRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Pedido não encontrado");
  const order = snap.data();

  if (order.customerUid && order.customerUid !== auth.uid) {
    throw new HttpsError("permission-denied", "Pedido não é seu");
  }
  if (!["waiting_confirmation", "pending"].includes(order.status)) {
    throw new HttpsError("failed-precondition", "Pedido já foi aceito ou finalizado — não dá pra estornar");
  }
  const paymentId = order.mpPaymentId || order.paymentId;
  if (!paymentId) {
    // Pedido não foi pago ainda — só cancela
    await orderRef.update({ status: "cancelled", cancelledAt: Date.now(), cancelReason: "client_cancelled" });
    return { ok: true, refunded: false };
  }

  // Estorno PIX é total (MP devolve via PIX pra mesma chave que pagou). Split
  // (pedido de loja) precisa do token do lojista; senão, plataforma.
  const refundToken = await refundTokenForOrder(order);
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}/refunds`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${refundToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  const result = await r.json();
  if (!r.ok) {
    console.error("MP refund failed", r.status, result);
    throw new HttpsError("internal", `MP refund error: ${result.message || r.status}`);
  }

  await orderRef.update({
    status: "refunded",
    refundedAt: Date.now(),
    refundId: String(result.id || ""),
    cancelReason: "client_refund_request",
  });
  return { ok: true, refunded: true, refundId: String(result.id || "") };
});

/**
 * Motorista solicita repasse PIX dos ganhos disponíveis.
 *
 * Lógica:
 *   1. Soma todas as entregas concluídas do motorista que ainda não foram pagas
 *      (status="completed" + payoutStatus indefinido/null/"available")
 *   2. Multiplica por 85% (DRIVER_SHARE)
 *   3. Lê chave PIX do perfil do motorista
 *   4. Chama MP Money Out (PIX transfer) usando saldo da conta da empresa
 *   5. Marca todas as entregas como payoutStatus="pending" + cria registro
 *      em /payouts com paymentId pra rastrear
 *
 * O webhook MP confirma o payout via outra notificação e atualiza
 * payoutStatus pra "completed".
 */
exports.requestDriverPayout = onCall({ secrets: [MP_ACCESS_TOKEN_SECRET] }, async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Login obrigatório");
  if (!getMpToken()) throw new HttpsError("failed-precondition", "MP token não configurado");

  const uid = auth.uid;
  const profileRef = admin
    .firestore()
    .doc(`artifacts/${APP_ID}/users/${uid}/profile/driverInfo`);
  const profileSnap = await profileRef.get();
  if (!profileSnap.exists) throw new HttpsError("not-found", "Perfil não encontrado");
  const profile = profileSnap.data();

  if (profile.status !== "approved") {
    throw new HttpsError("permission-denied", "Cadastro ainda não aprovado");
  }
  if (!profile.pixKey || !profile.pixKeyType) {
    throw new HttpsError("failed-precondition", "Cadastre sua chave PIX no /Perfil antes de receber");
  }

  // Soma entregas com payout pendente
  const deliveriesSnap = await admin
    .firestore()
    .collection(`artifacts/${APP_ID}/public/data/orders`)
    .where("driverId", "==", uid)
    .where("status", "==", "completed")
    .get();

  const eligible = [];
  let totalCents = 0;
  deliveriesSnap.forEach((d) => {
    const o = d.data();
    if (o.payoutStatus === "completed" || o.payoutStatus === "pending") return;
    const driverEarn = driverEarnCents(o);
    if (driverEarn <= 0) return;
    eligible.push({ id: d.id, cents: driverEarn });
    totalCents += driverEarn;
  });

  if (eligible.length === 0 || totalCents < 100) {
    throw new HttpsError("failed-precondition", "Sem ganhos disponíveis para receber");
  }

  const amount = totalCents / 100;
  const payoutRef = admin
    .firestore()
    .collection(`artifacts/${APP_ID}/payouts`)
    .doc();

  // Cria registro de payout ANTES de chamar MP (idempotência)
  await payoutRef.set({
    driverId: uid,
    driverName: profile.name || profile.fullName || auth.token.email || uid,
    pixKey: profile.pixKey,
    pixKeyType: profile.pixKeyType,
    amount,
    deliveryIds: eligible.map((e) => e.id),
    status: "processing",
    createdAt: Date.now(),
  });

  // Marca entregas como pending (vai ser confirmado quando admin processar manualmente)
  // OBS: a API de PIX-out automático do MP exige enrollment especial. Enquanto
  // não temos isso liberado, o repasse é processado pelo admin via dashboard:
  // ele paga manualmente via app do banco/MP, depois clica "Marcar como pago"
  // no painel admin pra finalizar o registro.
  const batch = admin.firestore().batch();
  for (const e of eligible) {
    batch.update(
      admin.firestore().doc(`artifacts/${APP_ID}/public/data/orders/${e.id}`),
      { payoutStatus: "pending", payoutId: payoutRef.id, payoutRequestedAt: Date.now() }
    );
  }
  await batch.commit();

  await payoutRef.update({
    status: "pending",
    requestedAt: Date.now(),
  });

  return {
    ok: true,
    payoutId: payoutRef.id,
    amount,
    deliveryCount: eligible.length,
    message: "Solicitação enviada. O repasse via PIX cai na sua chave em até 24h.",
  };
});

/**
 * Admin marca payout como pago (depois de pagar manualmente via MP/banco)
 * ou como cancelado (devolve ganhos para o saldo do motorista).
 */
exports.adminUpdatePayoutStatus = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Login obrigatório");
  if (auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Apenas admin");
  }

  const { payoutId, action, note, receiptUrl } = request.data || {};
  if (!payoutId || !["complete", "cancel"].includes(action)) {
    throw new HttpsError("invalid-argument", "payoutId e action (complete|cancel) obrigatórios");
  }

  const payoutRef = admin.firestore().doc(`artifacts/${APP_ID}/payouts/${payoutId}`);
  const snap = await payoutRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Payout não encontrado");
  const payout = snap.data();
  const deliveryIds = Array.isArray(payout.deliveryIds) ? payout.deliveryIds : [];

  const batch = admin.firestore().batch();
  if (action === "complete") {
    const completedAt = Date.now();
    const update = {
      status: "completed",
      completedAt,
      completedBy: auth.uid,
      adminNote: note || null,
    };
    if (typeof receiptUrl === "string" && receiptUrl.length > 0) {
      update.receiptUrl = receiptUrl;
    }
    batch.update(payoutRef, update);
    for (const id of deliveryIds) {
      batch.update(
        admin.firestore().doc(`artifacts/${APP_ID}/public/data/orders/${id}`),
        { payoutStatus: "completed", payoutCompletedAt: completedAt }
      );
    }
  } else {
    // cancel: devolve as entregas pro saldo disponível (limpa payoutStatus)
    batch.update(payoutRef, {
      status: "cancelled",
      cancelledAt: Date.now(),
      cancelledBy: auth.uid,
      adminNote: note || null,
    });
    for (const id of deliveryIds) {
      batch.update(
        admin.firestore().doc(`artifacts/${APP_ID}/public/data/orders/${id}`),
        { payoutStatus: admin.firestore.FieldValue.delete(), payoutId: admin.firestore.FieldValue.delete() }
      );
    }
  }
  await batch.commit();

  // Push notification ao motorista quando o saque é finalizado (completed/cancelled).
  try {
    const driverId = payout.driverId;
    if (driverId) {
      const profSnap = await admin
        .firestore()
        .doc(`artifacts/${APP_ID}/users/${driverId}/profile/driverInfo`)
        .get();
      const token = profSnap.exists ? profSnap.get("fcmToken") : null;
      if (typeof token === "string" && token.length > 10) {
        const amount = typeof payout.amount === "number" ? payout.amount.toFixed(2) : "?";
        const title = action === "complete" ? "Saque PIX enviado" : "Saque cancelado";
        const body = action === "complete"
          ? `R$ ${amount} foi transferido pra sua chave PIX.`
          : `Seu saque de R$ ${amount} foi cancelado. Os ganhos voltaram pro saldo.`;
        await admin.messaging().send({
          token,
          notification: { title, body },
          android: {
            priority: "high",
            notification: {
              channelId: "namao_payouts",
              sound: "new_message",
              defaultVibrateTimings: true,
            },
          },
          data: {
            type: "payout_update",
            payoutId: String(payoutId),
            action: String(action),
          },
        });
      }
    }
  } catch (e) {
    console.warn("[adminUpdatePayoutStatus] push notify failed", e);
  }

  return { ok: true };
});

/**
 * Helper pra motorista consultar saldo disponível.
 * Retorna soma das entregas concluídas não-pagas.
 */
exports.getDriverBalance = onCall(async (request) => {
  const auth = request.auth;
  if (!auth) throw new HttpsError("unauthenticated", "Login obrigatório");
  const uid = auth.uid;

  const snap = await admin
    .firestore()
    .collection(`artifacts/${APP_ID}/public/data/orders`)
    .where("driverId", "==", uid)
    .where("status", "==", "completed")
    .get();

  let availableCents = 0;
  let pendingCents = 0;
  let totalEarnedCents = 0;
  const deliveries = [];

  snap.forEach((d) => {
    const o = d.data();
    const cents = driverEarnCents(o);
    totalEarnedCents += cents;
    deliveries.push({
      id: d.id,
      shortId: d.id.slice(-6).toUpperCase(),
      amount: cents / 100,
      completedAt: o.completedAt || o.deliveredAt || null,
      payoutStatus: o.payoutStatus || "available",
      origin: o.origin || "",
      destination: o.destination || "",
    });
    if (o.payoutStatus === "completed") return;
    if (o.payoutStatus === "pending") {
      pendingCents += cents;
      return;
    }
    availableCents += cents;
  });

  // Histórico de saques (payouts) do motorista — com link de comprovante se já pago.
  const payoutsSnap = await admin
    .firestore()
    .collection(`artifacts/${APP_ID}/payouts`)
    .where("driverId", "==", uid)
    .get();
  const payouts = [];
  payoutsSnap.forEach((p) => {
    const v = p.data();
    payouts.push({
      id: p.id,
      shortId: p.id.slice(-6).toUpperCase(),
      amount: Number(v.amount || 0),
      status: v.status || "processing",
      pixKey: v.pixKey || "",
      pixKeyType: v.pixKeyType || "",
      createdAt: v.createdAt || 0,
      completedAt: v.completedAt || null,
      cancelledAt: v.cancelledAt || null,
      receiptUrl: v.receiptUrl || null,
      adminNote: v.adminNote || null,
    });
  });
  payouts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return {
    available: availableCents / 100,
    pending: pendingCents / 100,
    totalEarned: totalEarnedCents / 100,
    deliveries: deliveries.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)),
    payouts,
  };
});

/* ===========================================================================
 * MERCHANT — timeout de aceite (10 min) + dispatch ao motorista após aceite
 * =========================================================================== */

/**
 * Executa o estorno PIX no Mercado Pago e atualiza o pedido para `refunded`.
 * Idempotente: se já existe refundId no doc, retorna sem chamar MP.
 */
const REFUND_MAX_ATTEMPTS = 8;

async function executeMpRefund(orderRef, orderData, reason) {
  // Idempotência — já estornado?
  if (orderData.refundId || orderData.status === "refunded") {
    await orderRef.update({ refundPending: false });
    return { skipped: true };
  }
  // O PWA grava o id do pagamento como `mpPaymentId`; o fluxo legado usa
  // `paymentId`. Aceita os dois.
  const paymentId = orderData.mpPaymentId || orderData.paymentId;
  // Sem id de pagamento — pedido nunca foi pago, só limpa a flag.
  if (!paymentId) {
    await orderRef.update({
      refundPending: false,
      refundedAt: Date.now(),
      refundSkipped: "no_payment_id",
    });
    return { skipped: true };
  }

  // Split (pedido de loja) precisa do token do lojista; senão, plataforma.
  const token = await refundTokenForOrder(orderData);
  if (!token) {
    console.error("[refund] MP token ausente — não vou chamar API");
    return { error: "no_mp_token" };
  }

  const idempotencyKey = `refund-${orderRef.id}-${reason}`;
  const r = await fetch(
    `https://api.mercadopago.com/v1/payments/${paymentId}/refunds`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey,
      },
    }
  );
  const result = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error(
      `[refund] MP rejeitou refund do pedido ${orderRef.id}:`,
      r.status,
      result
    );
    // Mantém `refundPending: true` pra o sweep tentar de novo (ex.: saldo do
    // lojista ainda indisponível). Desiste depois de N tentativas e marca o
    // pedido pra estorno manual.
    const attempts = Number(orderData.refundAttempts || 0) + 1;
    const giveUp = attempts >= REFUND_MAX_ATTEMPTS;
    await orderRef.update({
      refundError: `MP ${r.status}: ${result.message || "erro"}`,
      refundAttemptedAt: Date.now(),
      refundAttempts: attempts,
      refundPending: !giveUp,
      ...(giveUp ? { refundNeedsManual: true } : {}),
    });
    return { error: result.message || `mp_${r.status}`, attempts, giveUp };
  }

  await orderRef.update({
    status: "refunded",
    refundedAt: Date.now(),
    refundId: String(result.id || ""),
    refundReason: reason,
    refundPending: false,
    refundError: admin.firestore.FieldValue.delete(),
  });
  console.log(
    `[refund] pedido ${orderRef.id} estornado (motivo=${reason}, refundId=${result.id})`
  );
  return { ok: true, refundId: String(result.id || "") };
}

/**
 * Trigger: quando qualquer pedido recebe `refundPending: true`, executa o
 * estorno automático no Mercado Pago. Cobre tanto recusa do lojista quanto
 * timeout de 10 minutos sem aceite.
 */
exports.onOrderRefundPending = onDocumentUpdated(
  {
    document: `artifacts/${APP_ID}/public/data/orders/{orderId}`,
    secrets: [MP_ACCESS_TOKEN_SECRET],
  },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;
    const becamePending = !before.refundPending && after.refundPending === true;
    if (!becamePending) return;
    if (after.refundId) return; // já processado
    const reason = after.cancelReason || "unknown";
    try {
      await executeMpRefund(event.data.after.ref, after, reason);
    } catch (err) {
      console.error(`[refund] erro inesperado em ${event.params.orderId}:`, err);
      await event.data.after.ref.update({
        refundError: err && err.message ? err.message : "unknown",
        refundAttemptedAt: Date.now(),
      });
    }
  }
);

/**
 * Roda a cada minuto e cancela pedidos de loja que passaram do prazo de
 * aceite (merchantAcceptDeadline). Marca `refundPending: true` — o trigger
 * `onOrderRefundPending` cuida do estorno MP automaticamente.
 */
exports.merchantAcceptanceTimeout = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    secrets: [MP_ACCESS_TOKEN_SECRET],
  },
  async () => {
    const now = Date.now();
    const snap = await admin
      .firestore()
      .collection(`artifacts/${APP_ID}/public/data/orders`)
      .where("status", "==", "awaiting_merchant_acceptance")
      .where("merchantAcceptDeadline", "<", now)
      .limit(50)
      .get();

    if (snap.empty) return;

    const batch = admin.firestore().batch();
    snap.forEach((doc) => {
      batch.update(doc.ref, {
        status: "cancelled",
        cancelReason: "merchant_timeout",
        merchantTimedOutAt: now,
        refundPending: true,
      });
    });
    await batch.commit();
    console.log(`[merchantTimeout] cancelados ${snap.size} pedidos`);
  }
);

/**
 * Sweep de retry: reprocessa estornos que ficaram `refundPending: true` mas
 * ainda não saíram (ex.: na 1ª tentativa o saldo do lojista no MP ainda não
 * estava disponível). O trigger `onOrderRefundPending` só dispara na transição
 * false→true, então este agendado garante as novas tentativas.
 */
exports.retryPendingRefunds = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "America/Sao_Paulo",
    region: "us-central1",
    secrets: [MP_ACCESS_TOKEN_SECRET],
  },
  async () => {
    const snap = await admin
      .firestore()
      .collection(`artifacts/${APP_ID}/public/data/orders`)
      .where("refundPending", "==", true)
      .limit(50)
      .get();
    if (snap.empty) return;

    let done = 0;
    for (const doc of snap.docs) {
      const data = doc.data();
      if (data.refundId) {
        await doc.ref.update({ refundPending: false });
        continue;
      }
      try {
        const res = await executeMpRefund(doc.ref, data, data.cancelReason || "retry");
        if (res && res.ok) done++;
      } catch (err) {
        console.error(`[refund-retry] erro em ${doc.id}:`, err);
      }
    }
    console.log(`[refund-retry] varridos ${snap.size}, estornados ${done}`);
  }
);

/**
 * Web Push pro lojista quando pedido entra em `awaiting_merchant_acceptance`.
 *
 * Lê `pushSubscriptions` do merchant doc e envia VAPID push pra cada
 * subscription. Endpoints inválidos (410/404) são removidos automaticamente.
 *
 * Combinado com o WhatsApp fallback + som contínuo no mini-admin, garante
 * que o lojista não perca o pedido nos 10 min de aceite.
 */
async function notifyMerchantNewOrder(orderData, orderId) {
  const storeId = orderData.storeId;
  if (!storeId) return;

  const pub = VAPID_PUBLIC_KEY_SECRET.value() || process.env.VAPID_PUBLIC_KEY || "";
  const priv = VAPID_PRIVATE_KEY_SECRET.value() || process.env.VAPID_PRIVATE_KEY || "";
  const subj = VAPID_SUBJECT_SECRET.value() || process.env.VAPID_SUBJECT || "mailto:dev@usenamao.com";
  if (!pub || !priv) {
    console.warn("[merchantPush] VAPID secrets ausentes — pulando push");
    return;
  }

  const merchantRef = admin
    .firestore()
    .doc(`artifacts/${APP_ID}/public/data/merchants/${storeId}`);
  const merchantSnap = await merchantRef.get();
  if (!merchantSnap.exists) return;
  const subs = merchantSnap.get("pushSubscriptions");
  if (!Array.isArray(subs) || subs.length === 0) return;

  const webpush = require("web-push");
  webpush.setVapidDetails(subj, pub, priv);

  const itemsTotal = typeof orderData.itemsTotalCents === "number"
    ? (orderData.itemsTotalCents / 100).toFixed(2)
    : "?";
  const itemCount = Array.isArray(orderData.items)
    ? orderData.items.reduce((s, i) => s + (Number(i.qty) || 0), 0)
    : 0;

  const payload = JSON.stringify({
    title: "🛎️ Novo pedido — aceite em 10 min!",
    body: `${itemCount} ${itemCount === 1 ? "item" : "itens"} · R$ ${itemsTotal} · ${
      orderData.customerName || "Cliente"
    }`,
    tag: `order-${orderId}`,
    data: {
      orderId: String(orderId),
      url: "/loja-admin",
    },
  });

  const surviving = [];
  for (const sub of subs) {
    if (!sub || !sub.endpoint) continue;
    try {
      await webpush.sendNotification(sub, payload, { TTL: 600 });
      surviving.push(sub);
    } catch (err) {
      const status = err && (err.statusCode || err.status);
      if (status === 404 || status === 410) {
        console.log(`[merchantPush] subscription expirou (${status}), removendo`);
        // Não inclui em surviving — vai sumir do array
      } else {
        console.error(`[merchantPush] erro ao enviar:`, err && err.body ? err.body : err);
        surviving.push(sub); // mantém — pode ser falha temporária
      }
    }
  }
  if (surviving.length !== subs.length) {
    await merchantRef.update({ pushSubscriptions: surviving });
  }
}

exports.onMerchantOrderArrived = onDocumentUpdated(
  {
    document: `artifacts/${APP_ID}/public/data/orders/{orderId}`,
    secrets: [VAPID_PUBLIC_KEY_SECRET, VAPID_PRIVATE_KEY_SECRET, VAPID_SUBJECT_SECRET],
  },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;
    // Dispara só na transição pra awaiting_merchant_acceptance.
    if (
      before.status !== "awaiting_merchant_acceptance" &&
      after.status === "awaiting_merchant_acceptance"
    ) {
      try {
        await notifyMerchantNewOrder(after, event.params.orderId);
      } catch (err) {
        console.error("[merchantPush] erro:", err);
      }
    }
  }
);

// Também cobre o caso de o pedido já entrar em awaiting_merchant_acceptance
// (ex.: documento criado direto nesse status, sem passar por update).
exports.onMerchantOrderCreated = onDocumentCreated(
  {
    document: `artifacts/${APP_ID}/public/data/orders/{orderId}`,
    secrets: [VAPID_PUBLIC_KEY_SECRET, VAPID_PRIVATE_KEY_SECRET, VAPID_SUBJECT_SECRET],
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    if (data.status !== "awaiting_merchant_acceptance") return;
    try {
      await notifyMerchantNewOrder(data, event.params.orderId);
    } catch (err) {
      console.error("[merchantPush] erro:", err);
    }
  }
);

/**
 * Quando o merchant aceita (API route flipa status → pending), dispara o
 * mesmo fluxo dos pedidos ponto-a-ponto. O onOrderCreated/onOrderStatusChange
 * já cuida do resto. Aqui apenas garantimos que a transição é registrada.
 */
exports.onMerchantAccepted = onDocumentUpdated(
  `artifacts/${APP_ID}/public/data/orders/{orderId}`,
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;
    if (before.status === "awaiting_merchant_acceptance" && after.status === "pending") {
      console.log(`[merchant] pedido ${event.params.orderId} aceito → dispatch`);
      await notifyAvailableDrivers(after, event.params.orderId);
    }
  }
);

/**
 * Quando o admin publica um comunicado (broadcast), dispara FCM pra audience
 * (drivers/customers/all). Sem isso o doc fica no Firestore mas o app driver
 * não tem nada ouvindo — o motorista nunca vê.
 *
 * Audience:
 *  - "drivers" → todos os motoristas com status=approved (channel padrão)
 *  - "customers" → todos os clientes que tiverem customerFcmToken em algum pedido
 *  - "all" → drivers + customers
 *
 * Idempotente: marca o doc com broadcastedAt na primeira vez e nunca refaz.
 */
async function notifyDriversBroadcast(broadcast, broadcastId) {
  const tokens = [];
  if (broadcast.targetUid) {
    // Mensagem direta pra um motorista específico (enviada pelo admin).
    const snap = await admin
      .firestore()
      .doc(`artifacts/${APP_ID}/users/${broadcast.targetUid}/profile/driverInfo`)
      .get();
    const t = snap.exists ? snap.get("fcmToken") : null;
    if (typeof t === "string" && t.length > 10) tokens.push(t);
  } else {
    const profilesSnap = await admin
      .firestore()
      .collectionGroup("profile")
      .where("status", "==", "approved")
      .get();
    profilesSnap.forEach((doc) => {
      if (doc.id !== "driverInfo") return;
      const t = doc.get("fcmToken");
      if (typeof t === "string" && t.length > 10) tokens.push(t);
    });
  }
  if (!tokens.length) return { sent: 0, failed: 0 };

  const title = String(broadcast.title || "Comunicado NaMão").slice(0, 80);
  const body = String(broadcast.message || "").slice(0, 220);

  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    android: {
      priority: "high",
      notification: {
        channelId: "namao_orders_v2",
        defaultSound: true,
        defaultVibrateTimings: true,
      },
    },
    data: {
      type: "broadcast",
      broadcastId: String(broadcastId),
      title,
      body,
    },
  });
  return { sent: res.successCount, failed: res.failureCount };
}

async function notifyCustomersBroadcast(broadcast, broadcastId) {
  // Não temos uma coleção de clientes — pegamos os customerFcmToken dos
  // últimos 1000 pedidos. Dedup por token antes de enviar.
  const snap = await admin
    .firestore()
    .collection(`artifacts/${APP_ID}/public/data/orders`)
    .orderBy("createdAt", "desc")
    .limit(1000)
    .get();
  const tokens = new Set();
  snap.forEach((d) => {
    const t = d.get("customerFcmToken");
    if (typeof t === "string" && t.length > 10) tokens.add(t);
  });
  if (!tokens.size) return { sent: 0, failed: 0 };

  const title = String(broadcast.title || "Comunicado NaMão").slice(0, 80);
  const body = String(broadcast.message || "").slice(0, 220);

  const res = await admin.messaging().sendEachForMulticast({
    tokens: Array.from(tokens),
    notification: { title, body },
    data: {
      type: "broadcast",
      broadcastId: String(broadcastId),
      title,
      body,
    },
  });
  return { sent: res.successCount, failed: res.failureCount };
}

exports.onBroadcastCreated = onDocumentCreated(
  `artifacts/${APP_ID}/public/data/broadcasts/{broadcastId}`,
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    if (data.broadcastedAt) return; // idempotência
    const audience = data.audience || "drivers";
    const broadcastId = event.params.broadcastId;

    const result = { drivers: null, customers: null };
    try {
      if (audience === "drivers" || audience === "all") {
        result.drivers = await notifyDriversBroadcast(data, broadcastId);
      }
      if (audience === "customers" || audience === "all") {
        result.customers = await notifyCustomersBroadcast(data, broadcastId);
      }
    } catch (err) {
      console.error("[broadcast] erro ao enviar:", err);
    }

    try {
      await event.data.ref.update({
        broadcastedAt: Date.now(),
        broadcastResult: result,
      });
    } catch (err) {
      console.warn("[broadcast] erro ao marcar broadcastedAt:", err);
    }
    console.log(`[broadcast] ${broadcastId} audience=${audience}`, result);
  }
);
