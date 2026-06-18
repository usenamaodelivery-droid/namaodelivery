// Cliente cria/recupera o PIX QR Code de um pedido.
// POST /api/createOrderPix  Body: { orderId }
// Auth: Bearer <Firebase ID token>
const { db, verifyAuth, readJson, send, sendError, getMpToken, APP_ID } = require("../lib/firebase");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return send(res, 405, { error: "Method not allowed" });
  }

  try {
    const auth = await verifyAuth(req);
    const token = getMpToken();
    if (!token) {
      return send(res, 503, { error: "MP token não configurado" });
    }

    const body = await readJson(req);
    const orderId = body?.orderId;
    if (!orderId) return send(res, 400, { error: "orderId obrigatório" });

    const orderRef = db().doc(`artifacts/${APP_ID}/public/data/orders/${orderId}`);
    const snap = await orderRef.get();
    if (!snap.exists) return send(res, 404, { error: "Pedido não encontrado" });
    const order = snap.data();

    if (order.customerUid && order.customerUid !== auth.uid) {
      return send(res, 403, { error: "Pedido não é seu" });
    }

    if (order.paymentId && order.paymentQrCode) {
      return send(res, 200, {
        paymentId: order.paymentId,
        qrCode: order.paymentQrCode,
        qrCodeBase64: order.paymentQrCodeBase64,
        ticketUrl: order.paymentTicketUrl,
      });
    }

    const amount = Number(order.price);
    if (!amount || amount <= 0) {
      return send(res, 400, { error: "Pedido sem valor" });
    }

    const idempotencyKey = `order-${orderId}-${Date.now()}`;
    const r = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
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
          email: auth.email || `cliente-${auth.uid}@namaodelivery.com`,
          first_name: order.customerName || "Cliente",
        },
        notification_url: process.env.MP_WEBHOOK_URL || undefined,
      }),
    });

    const result = await r.json();
    if (!r.ok) {
      console.error("MP createPayment failed", r.status, result);
      return send(res, 502, { error: `MP error: ${result.message || r.status}` });
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

    return send(res, 200, {
      paymentId: String(result.id),
      qrCode,
      qrCodeBase64,
      ticketUrl,
    });
  } catch (e) {
    return sendError(res, e);
  }
};
