import {
  collection,
  onSnapshot,
  updateDoc,
  doc,
  runTransaction,
  query,
  where,
  orderBy
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db } from "./firebaseInit.js";
import {
  APP_ID,
  DRIVER_SHARE
} from "./firebaseConfig.js";

const ordersCol = () => collection(db, "artifacts", APP_ID, "public", "data", "orders");

/** Admin confirma PIX — pedido passa a ser visível aos motoristas. */
export async function adminConfirmPix(orderId) {
  await updateDoc(doc(ordersCol(), orderId), {
    status: "pending",
    pixConfirmedAt: Date.now()
  });
}

/** Motorista aceita um pedido em "pending". */
export async function acceptOrder(orderId, driverId, driverName) {
  await runTransaction(db, async (tx) => {
    const ref = doc(ordersCol(), orderId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Pedido não existe");
    const data = snap.data();
    if (data.status !== "pending") throw new Error("Pedido já foi aceito por outro motorista");
    tx.update(ref, {
      status: "accepted",
      driverId,
      driverName,
      acceptedAt: Date.now()
    });
  });
}

/** Atualiza posição do motorista (chamado pelo tracker de geolocalização). */
export async function updateDriverLocation(orderId, lat, lng) {
  await updateDoc(doc(ordersCol(), orderId), {
    driverLat: lat,
    driverLng: lng,
    lastLocationAt: Date.now()
  });
}

/**
 * Marca pedido como in_transit (motorista coletou).
 *
 * @param {string} orderId
 * @param {string} [pickupPhotoUrl] data URL ou URL do Storage com a foto
 *   da retirada (POD "antes"). Opcional pra retro-compat, mas a UI atual
 *   sempre passa.
 */
export async function markInTransit(orderId, pickupPhotoUrl) {
  const update = {
    status: "in_transit",
    pickupAt: Date.now(),
  };
  if (pickupPhotoUrl) update.pickupPhotoUrl = pickupPhotoUrl;
  await updateDoc(doc(ordersCol(), orderId), update);
}

/**
 * Finaliza pedido com prova de entrega + credita carteira do motorista
 * em uma única transação (evita dupla contagem).
 */
export async function completeOrder({ orderId, driverId, photoUrl, signatureUrl }) {
  await runTransaction(db, async (tx) => {
    const orderRef = doc(ordersCol(), orderId);
    const walletRef = doc(db, "artifacts", APP_ID, "users", driverId, "profile", "driverInfo");

    const [orderSnap, walletSnap] = await Promise.all([tx.get(orderRef), tx.get(walletRef)]);
    if (!orderSnap.exists()) throw new Error("Pedido inexistente");
    const order = orderSnap.data();
    if (order.status === "completed") throw new Error("Pedido já foi finalizado");
    if (order.driverId !== driverId) throw new Error("Apenas o motorista responsável pode finalizar");

    // Fonte única: o repasse (fatia do FRETE) é gravado na criação do pedido
    // pelo Pedir NaMão. Aqui o app só credita esse valor; nunca recalcula sobre
    // o total. Fallback só para pedidos legados sem o campo novo.
    const freteCents = typeof order.deliveryPriceCents === "number" ? order.deliveryPriceCents : null;
    let driverEarnings;
    if (typeof order.driverEarningsCents === "number") {
      driverEarnings = round2(order.driverEarningsCents / 100);
    } else if (freteCents != null) {
      console.warn(`[completeOrder] pedido ${orderId} sem driverEarningsCents; usando frete×${DRIVER_SHARE} (legado)`);
      driverEarnings = round2((freteCents / 100) * DRIVER_SHARE);
    } else {
      console.warn(`[completeOrder] pedido ${orderId} sem frete; usando price×${DRIVER_SHARE} (legado)`);
      driverEarnings = round2(Number(order.price || 0) * DRIVER_SHARE);
    }
    const freteReais = freteCents != null ? freteCents / 100 : Number(order.price || 0);
    const platformFee = round2(Math.max(0, freteReais - driverEarnings));

    const currentBalance = walletSnap.exists() ? Number(walletSnap.data().balance || 0) : 0;
    const newBalance = round2(currentBalance + driverEarnings);

    tx.update(orderRef, {
      status: "completed",
      completedAt: Date.now(),
      podPhotoUrl: photoUrl,
      podSignatureUrl: signatureUrl,
      driverEarnings,
      platformFee
    });
    tx.update(walletRef, {
      balance: newBalance,
      totalEarnings: round2((walletSnap.data()?.totalEarnings || 0) + driverEarnings),
      totalDeliveries: (walletSnap.data()?.totalDeliveries || 0) + 1,
      lastDeliveryAt: Date.now()
    });
  });
}

/** Subscreve mudanças na coleção de pedidos. Retorna unsubscribe. */
export function subscribeOrders(cb) {
  return onSnapshot(ordersCol(), (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => b.createdAt - a.createdAt);
    cb(list);
  });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
