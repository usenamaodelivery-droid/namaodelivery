// Motorista consulta saldo disponível (soma 85% das entregas concluídas).
// POST /api/getDriverBalance
const { db, verifyAuth, send, sendError, APP_ID, DRIVER_SHARE } = require("../lib/firebase");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST" && req.method !== "GET") {
    return send(res, 405, { error: "Method not allowed" });
  }

  try {
    const auth = await verifyAuth(req);
    const uid = auth.uid;

    const snap = await db()
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

    return send(res, 200, {
      available: availableCents / 100,
      pending: pendingCents / 100,
      totalEarned: totalEarnedCents / 100,
      deliveries: deliveries.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)),
    });
  } catch (e) {
    return sendError(res, e);
  }
};
