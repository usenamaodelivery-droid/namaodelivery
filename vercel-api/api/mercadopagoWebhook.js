// Webhook do Mercado Pago. Configurar URL no painel MP:
//   https://<deployment>.vercel.app/api/mercadopagoWebhook
// Recebe notificações de payment. Quando aprovado, libera pedido pros motoristas.

const { db, readJson, send, getMpToken, APP_ID } = require("../lib/firebase");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    const body = await readJson(req);
    const type = body?.type || req.query?.type;
    const dataId = body?.data?.id || req.query?.["data.id"] || req.query?.id;

    if (!type || !dataId) {
      send(res, 200, { ok: true });
      return;
    }

    if (type === "payment") {
      const r = await fetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
        headers: { Authorization: `Bearer ${getMpToken()}` },
      });
      if (!r.ok) {
        console.error("MP payment fetch failed", r.status);
        send(res, 200, { ok: true });
        return;
      }
      const payment = await r.json();
      const orderId = payment.external_reference || payment.metadata?.order_id;
      if (!orderId) {
        send(res, 200, { ok: true });
        return;
      }
      const orderRef = db().doc(`artifacts/${APP_ID}/public/data/orders/${orderId}`);
      const before = (await orderRef.get()).data();
      if (!before) {
        send(res, 200, { ok: true });
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
        update.status = "pending";
        update.paymentApprovedAt = Date.now();
      }
      if (payment.status === "refunded") {
        update.status = "refunded";
        update.refundedAt = Date.now();
      }
      await orderRef.update(update);
    }

    send(res, 200, { ok: true });
  } catch (e) {
    console.error("mercadopagoWebhook error", e);
    // Sempre 200 pra MP não tentar mil vezes
    send(res, 200, { ok: true });
  }
};
