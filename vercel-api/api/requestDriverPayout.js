// Motorista solicita repasse PIX dos ganhos disponíveis (85% do total).
// POST /api/requestDriverPayout  Body: {}  (uid vem do token)
const {
  db,
  admin,
  verifyAuth,
  readJson,
  send,
  sendError,
  getMpToken,
  APP_ID,
  DRIVER_SHARE,
} = require("../lib/firebase");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return send(res, 405, { error: "Method not allowed" });
  }

  try {
    const auth = await verifyAuth(req);
    const token = getMpToken();
    if (!token) return send(res, 503, { error: "MP token não configurado" });

    await readJson(req); // consome body se existir

    const uid = auth.uid;
    const profileRef = db().doc(`artifacts/${APP_ID}/users/${uid}/profile/driverInfo`);
    const profileSnap = await profileRef.get();
    if (!profileSnap.exists) return send(res, 404, { error: "Perfil não encontrado" });
    const profile = profileSnap.data();

    if (profile.status !== "approved") {
      return send(res, 403, { error: "Cadastro ainda não aprovado" });
    }
    if (!profile.pixKey || !profile.pixKeyType) {
      return send(res, 400, { error: "Cadastre sua chave PIX antes de receber" });
    }

    const deliveriesSnap = await db()
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
      return send(res, 400, { error: "Sem ganhos disponíveis para receber" });
    }

    const amount = totalCents / 100;
    const payoutRef = db().collection(`artifacts/${APP_ID}/payouts`).doc();

    await payoutRef.set({
      driverId: uid,
      driverName: profile.name || profile.fullName || auth.email || uid,
      pixKey: profile.pixKey,
      pixKeyType: profile.pixKeyType,
      amount,
      deliveryIds: eligible.map((e) => e.id),
      status: "processing",
      createdAt: Date.now(),
    });

    const idempotencyKey = `payout-${payoutRef.id}`;
    let mpResponse;
    try {
      const r = await fetch("https://api.mercadopago.com/v1/money_requests", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
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
        return send(res, 502, { error: `Falha no MP: ${mpResponse.message || r.status}` });
      }
    } catch (e) {
      await payoutRef.update({ status: "failed", error: String(e), failedAt: Date.now() });
      return send(res, 502, { error: "Erro ao chamar Mercado Pago" });
    }

    const batch = db().batch();
    for (const e of eligible) {
      batch.update(
        db().doc(`artifacts/${APP_ID}/public/data/orders/${e.id}`),
        { payoutStatus: "pending", payoutId: payoutRef.id, payoutRequestedAt: Date.now() }
      );
    }
    await batch.commit();

    await payoutRef.update({
      status: "pending",
      mpId: String(mpResponse.id || ""),
      mpStatus: mpResponse.status || "",
    });

    return send(res, 200, {
      ok: true,
      payoutId: payoutRef.id,
      amount,
      deliveryCount: eligible.length,
      mpStatus: mpResponse.status || "pending",
    });
  } catch (e) {
    return sendError(res, e);
  }
};
