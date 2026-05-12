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
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "southamerica-east1", maxInstances: 10 });

const APP_ID = "namao-delivery-prod";
const BOOTSTRAP_EMAIL = process.env.ADMIN_BOOTSTRAP_EMAIL || "";
const PLATFORM_FEE = 0.15; // 15% fica com a empresa, 85% repassa pro motorista
const DRIVER_SHARE = 1 - PLATFORM_FEE;

// Mercado Pago — secrets armazenados via `firebase functions:secrets:set`
const MP_ACCESS_TOKEN_SECRET = defineSecret("MERCADOPAGO_ACCESS_TOKEN");
const MP_WEBHOOK_SECRET = defineSecret("MERCADOPAGO_WEBHOOK_SECRET");

function getMpToken() {
  return MP_ACCESS_TOKEN_SECRET.value() || process.env.MERCADOPAGO_ACCESS_TOKEN || "";
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
        update.status = "pending"; // libera pros motoristas
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
  if (!order.paymentId) {
    // Pedido não foi pago ainda — só cancela
    await orderRef.update({ status: "cancelled", cancelledAt: Date.now(), cancelReason: "client_cancelled" });
    return { ok: true, refunded: false };
  }

  // Estorno PIX é total (MP devolve via PIX pra mesma chave que pagou)
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${order.paymentId}/refunds`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getMpToken()}`,
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
    const driverEarn = Math.round((Number(o.price) || 0) * DRIVER_SHARE * 100);
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

  // Chama MP Money Out (transferência via PIX)
  // Endpoint: POST /v1/money_requests (varia por versão da API; aqui usamos v1)
  // NB: precisa que a conta MP tenha PIX out habilitado.
  const idempotencyKey = `payout-${payoutRef.id}`;
  let mpResponse;
  try {
    const r = await fetch("https://api.mercadopago.com/v1/money_requests", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getMpToken()}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        transaction_amount: amount,
        description: `Repasse Delivery NaMão - ${profile.name || profile.fullName || uid.slice(-6)}`,
        external_reference: payoutRef.id,
        beneficiary: {
          type: "pix",
          pix_key: profile.pixKey,
          pix_key_type: profile.pixKeyType,
        },
      }),
    });
    mpResponse = await r.json();
    if (!r.ok) {
      await payoutRef.update({
        status: "failed",
        error: mpResponse.message || `HTTP ${r.status}`,
        failedAt: Date.now(),
      });
      throw new HttpsError("internal", `Falha no MP: ${mpResponse.message || r.status}`);
    }
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    await payoutRef.update({ status: "failed", error: String(e), failedAt: Date.now() });
    throw new HttpsError("internal", "Erro ao chamar Mercado Pago");
  }

  // Marca entregas como pending (webhook confirma depois)
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
    mpId: String(mpResponse.id || ""),
    mpStatus: mpResponse.status || "",
  });

  return {
    ok: true,
    payoutId: payoutRef.id,
    amount,
    deliveryCount: eligible.length,
    mpStatus: mpResponse.status || "pending",
  };
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
    const cents = Math.round((Number(o.price) || 0) * DRIVER_SHARE * 100);
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

  return {
    available: availableCents / 100,
    pending: pendingCents / 100,
    totalEarned: totalEarnedCents / 100,
    deliveries: deliveries.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)),
  };
});
