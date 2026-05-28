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
async function executeMpRefund(orderRef, orderData, reason) {
  // Idempotência — já estornado?
  if (orderData.refundId || orderData.status === "refunded") {
    await orderRef.update({ refundPending: false });
    return { skipped: true };
  }
  // Sem paymentId — pedido nunca foi pago, só limpa a flag.
  if (!orderData.paymentId) {
    await orderRef.update({
      refundPending: false,
      refundedAt: Date.now(),
      refundSkipped: "no_payment_id",
    });
    return { skipped: true };
  }

  const token = getMpToken();
  if (!token) {
    console.error("[refund] MP token ausente — não vou chamar API");
    return { error: "no_mp_token" };
  }

  const idempotencyKey = `refund-${orderRef.id}-${reason}`;
  const r = await fetch(
    `https://api.mercadopago.com/v1/payments/${orderData.paymentId}/refunds`,
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
    await orderRef.update({
      refundError: `MP ${r.status}: ${result.message || "erro"}`,
      refundAttemptedAt: Date.now(),
    });
    return { error: result.message || `mp_${r.status}` };
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
    }
  }
);
