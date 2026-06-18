/* global L */
// Mapa do entregador. App não tem mais lado cliente — só motorista.
//
// Recursos:
// - Tile bonito (CartoDB Voyager — colorido mas limpo)
// - Marker do motorista (motoboy estilizado em SVG)
// - Markers de origem/destino quando há corrida ativa
// - Linha de rota navy/dourado entre os pontos
// - Auto-fit pra mostrar trajeto inteiro

let mapDriver = null;
let driverMarker = null;
let originMarker = null;
let destMarker = null;
let routeLine = null;
let lastUserCoords = null;

// Recupera última localização conhecida do localStorage. Faz o mapa
// abrir imediatamente perto do motorista, sem esperar o GPS responder.
function readCachedCoords() {
  try {
    const raw = localStorage.getItem("namao_last_coords");
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length === 2 && arr.every(Number.isFinite)) {
      return arr;
    }
  } catch {}
  return null;
}

function saveCoordsToCache(coords) {
  try { localStorage.setItem("namao_last_coords", JSON.stringify(coords)); } catch {}
}

const cachedStart = readCachedCoords();
export let startCoords = cachedStart || [-23.55, -46.63]; // último conhecido ou SP fallback
export let destCoords = null;

// SVG icons custom (motoboy + pin origem + pin destino)
const driverIcon = () => L.divIcon({
  className: "namao-driver-icon",
  iconSize: [44, 44],
  iconAnchor: [22, 22],
  html: `
    <div class="relative w-11 h-11 flex items-center justify-center">
      <div class="absolute inset-0 rounded-full bg-accent/30 animate-ping"></div>
      <div class="relative w-11 h-11 rounded-full bg-accent border-4 border-white shadow-xl flex items-center justify-center">
        <i class="fa-solid fa-motorcycle text-primary text-lg"></i>
      </div>
    </div>`
});

const pinOrigin = () => L.divIcon({
  className: "namao-pin",
  iconSize: [36, 44],
  iconAnchor: [18, 42],
  html: `
    <div class="relative">
      <div class="w-9 h-9 rounded-full bg-primary border-4 border-white shadow-xl flex items-center justify-center">
        <i class="fa-solid fa-store text-white text-sm"></i>
      </div>
      <div class="absolute left-1/2 -translate-x-1/2 -bottom-1 w-3 h-3 bg-primary rotate-45 shadow-lg"></div>
    </div>`
});

const pinDestination = () => L.divIcon({
  className: "namao-pin",
  iconSize: [36, 44],
  iconAnchor: [18, 42],
  html: `
    <div class="relative">
      <div class="w-9 h-9 rounded-full bg-accent border-4 border-white shadow-xl flex items-center justify-center">
        <i class="fa-solid fa-flag-checkered text-primary text-sm"></i>
      </div>
      <div class="absolute left-1/2 -translate-x-1/2 -bottom-1 w-3 h-3 bg-accent rotate-45 shadow-lg"></div>
    </div>`
});

export function initDriverMap() {
  const el = document.getElementById("map-entregador");
  if (!el || mapDriver) return;
  mapDriver = L.map("map-entregador", {
    zoomControl: false,
    attributionControl: false,
    preferCanvas: true,
    zoomAnimation: true,
    fadeAnimation: true,
  }).setView(startCoords, 13);

  // Tile colorido mas elegante (CartoDB Voyager).
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 20,
    detectRetina: true,
  }).addTo(mapDriver);

  // Pequeno controle de zoom no canto inferior esquerdo
  L.control.zoom({ position: "bottomleft" }).addTo(mapDriver);

  // Coloca já o marker no último conhecido pra dar feedback imediato
  if (cachedStart) {
    lastUserCoords = cachedStart;
    placeDriverMarker(cachedStart);
    mapDriver.setView(cachedStart, 14);
  }

  locateUser((coords) => {
    startCoords = coords;
    lastUserCoords = coords;
    saveCoordsToCache(coords);
    mapDriver.setView(coords, 15);
    placeDriverMarker(coords);
  });
}

function placeDriverMarker(coords) {
  if (!mapDriver) return;
  if (driverMarker) {
    driverMarker.setLatLng(coords);
  } else {
    driverMarker = L.marker(coords, { icon: driverIcon(), zIndexOffset: 1000 }).addTo(mapDriver);
  }
}

function locateUser(cb) {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (p) => cb([p.coords.latitude, p.coords.longitude]),
    () => {},
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

/** Atualiza posição do entregador no mapa (chamado pelo tracker GPS). */
export function updateDriverPosition(lat, lng) {
  lastUserCoords = [lat, lng];
  saveCoordsToCache(lastUserCoords);
  if (!mapDriver) return;
  placeDriverMarker(lastUserCoords);
}

/** Centraliza mapa na localização atual do entregador. */
export function invalidateDriverMapSize() {
  if (!mapDriver) return;
  // Defer pra próxima frame pra garantir que o resize do container já foi aplicado
  requestAnimationFrame(() => mapDriver.invalidateSize());
}

export function centerDriverMap() {
  if (!mapDriver) return;
  if (lastUserCoords) {
    mapDriver.setView(lastUserCoords, 15, { animate: true });
    return;
  }
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (p) => {
      const c = [p.coords.latitude, p.coords.longitude];
      lastUserCoords = c;
      placeDriverMarker(c);
      mapDriver.setView(c, 15, { animate: true });
    },
    () => {},
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

/**
 * Mostra origem + destino + rota da corrida atual no mapa do motorista.
 * Chame com `null` para limpar.
 */
export function showActiveDelivery(order) {
  if (!mapDriver) return;
  clearActiveDelivery();
  if (!order) return;

  const orig = order.originCoords;
  const dest = order.destCoords;
  if (orig?.length === 2) {
    originMarker = L.marker(orig, { icon: pinOrigin() }).addTo(mapDriver);
  }
  if (dest?.length === 2) {
    destMarker = L.marker(dest, { icon: pinDestination() }).addTo(mapDriver);
  }
  if (orig?.length === 2 && dest?.length === 2) {
    // Linha tracejada navy + linha cheia dourada por cima (efeito dual)
    routeLine = L.layerGroup([
      L.polyline([orig, dest], { color: "#1B304F", weight: 8, opacity: 0.35, lineCap: "round" }),
      L.polyline([orig, dest], { color: "#E8B93A", weight: 4, opacity: 1, lineCap: "round", dashArray: "1, 12" }),
    ]).addTo(mapDriver);
  }

  const points = [];
  if (orig?.length === 2) points.push(orig);
  if (dest?.length === 2) points.push(dest);
  if (lastUserCoords) points.push(lastUserCoords);
  if (points.length >= 2) {
    mapDriver.fitBounds(L.latLngBounds(points), { padding: [50, 50], maxZoom: 15 });
  }
}

export function clearActiveDelivery() {
  if (originMarker) { originMarker.remove(); originMarker = null; }
  if (destMarker) { destMarker.remove(); destMarker = null; }
  if (routeLine) { routeLine.remove(); routeLine = null; }
}

export function straightLineKm(a, b) {
  return L.latLng(a).distanceTo(L.latLng(b)) / 1000;
}
