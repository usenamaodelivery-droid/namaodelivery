// Cliente cancela um pedido não-aceito e recebe estorno.
// POST /api/refundOrder  Body: { orderId }
const { db, verifyAuth, readJson, send, sendError, getMpToken, APP_ID } = require("../lib/firebase");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return send(res, 405, { error: "Method not allowed" });
  }

  try {
    const auth = await verifyAuth(req);
    const token = getMpToken();
    if (!token) return send(res, 503, { error: "MP token não configurado" });

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
    if (!["waiting_confirmation", "pending"].includes(order.status)) {
      return send(res, 400, { error: "Pedido já foi aceito ou finalizado" });
    }
    if (!order.paymentId) {
      await orderRef.update({
        status: "cancelled",
        cancelledAt: Date.now(),
        cancelReason: "client_cancelled",
      });
      return send(res, 200, { ok: true, refunded: false });
    }

    const r = await fetch(`https://api.mercadopago.com/v1/payments/${order.paymentId}/refunds`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const result = await r.json();
    if (!r.ok) {
      console.error("MP refund failed", r.status, result);
      return send(res, 502, { error: `MP refund error: ${result.message || r.status}` });
    }

    await orderRef.update({
      status: "refunded",
      refundedAt: Date.now(),
      refundId: String(result.id || ""),
      cancelReason: "client_refund_request",
    });
    return send(res, 200, { ok: true, refunded: true, refundId: String(result.id || "") });
  } catch (e) {
    return sendError(res, e);
  }
};
