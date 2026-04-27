/* global L */
// Leaflet é carregado via tag <script> no index.html.

let mapClient, mapDriver;
let originMarker = null, destMarker = null, routeLine = null;
export let startCoords = [-23.55, -46.63]; // São Paulo como fallback
export let destCoords = null;

export function initClientMap(onDestinationSelected) {
  const el = document.getElementById("map-cliente");
  if (!el || mapClient) return;

  mapClient = L.map("map-cliente", { zoomControl: false, attributionControl: false })
    .setView(startCoords, 13);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png").addTo(mapClient);

  locateUser((coords) => {
    startCoords = coords;
    mapClient.setView(coords, 15);
    originMarker = L.marker(coords).addTo(mapClient).bindPopup("Você está aqui").openPopup();
  });

  mapClient.on("click", (e) => {
    destCoords = [e.latlng.lat, e.latlng.lng];
    if (destMarker) destMarker.remove();
    destMarker = L.marker(destCoords).addTo(mapClient).bindPopup("Destino").openPopup();
    drawRoute();
    onDestinationSelected?.(destCoords);
  });
}

export function initDriverMap() {
  const el = document.getElementById("map-entregador");
  if (!el || mapDriver) return;
  mapDriver = L.map("map-entregador", { zoomControl: false, attributionControl: false })
    .setView(startCoords, 13);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png").addTo(mapDriver);
  locateUser((coords) => mapDriver.setView(coords, 14));
}

function locateUser(cb) {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (p) => cb([p.coords.latitude, p.coords.longitude]),
    () => {},
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function drawRoute() {
  if (!startCoords || !destCoords) return;
  if (routeLine) routeLine.remove();
  routeLine = L.polyline([startCoords, destCoords], { color: "#C9A84C", weight: 4 }).addTo(mapClient);
  mapClient.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
}

export function straightLineKm(a, b) {
  return L.latLng(a).distanceTo(L.latLng(b)) / 1000;
}
