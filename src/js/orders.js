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
  DRIVER_SHARE,
  PLATFORM_FEE
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

    const driverEarnings = round2(order.price * DRIVER_SHARE);
    const platformFee = round2(order.price * PLATFORM_FEE);

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
