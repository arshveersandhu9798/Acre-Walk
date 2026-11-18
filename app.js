import { firebaseConfig } from "./firebase-config.js";

const STORAGE_KEY = "fieldnote-surveys-v1";
const MAX_GPS_ACCURACY_METERS = 35;
const MIN_POINT_SPACING_METERS = 1.5;
const ACRE_IN_SQUARE_METERS = 4046.8564224;
const HECTARE_IN_SQUARE_METERS = 10000;

const $ = (selector) => document.querySelector(selector);
const elements = {
  area: $("#area-value"),
  areaUnit: $("#area-unit"),
  areaSecondary: $("#area-secondary"),
  distance: $("#distance-value"),
  accuracy: $("#accuracy-value"),
  statusIndicator: $("#status-indicator"),
  statusText: $("#status-text"),
  pointCount: $("#point-count"),
  gpsMessage: $("#gps-message"),
  mapCaption: $("#map-caption"),
  mapHelp: $(".map-help"),
  nameInput: $("#land-name"),
  start: $("#start-button"),
  pause: $("#pause-button"),
  finish: $("#finish-button"),
  locate: $("#locate-button"),
  auth: $("#auth-button"),
  authLabel: $("#auth-button-label"),
  syncLabel: $("#sync-label"),
  history: $("#history-list"),
  historyCount: $("#history-count"),
  clearHistory: $("#clear-history"),
  exportHistory: $("#export-history"),
  toast: $("#toast"),
};

let points = [];
let currentAccuracy = null;
let watchId = null;
let trackingState = "idle";
let map;
let trackLayer;
let currentUser = null;
let firebaseServices = null;
let toastTimer;
let surveys = readLocalSurveys();

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 4400);
}

function readLocalSurveys() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(stored)) throw new Error("Saved survey data is not a list.");
    return stored.filter((survey) => survey && typeof survey.id === "string" && Array.isArray(survey.points));
  } catch (error) {
    console.error("Could not read saved surveys:", error);
    showToast("Saved surveys could not be read from this device.", true);
    return [];
  }
}

function persistLocalSurveys() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(surveys));
  } catch (error) {
    console.error("Could not save surveys on this device:", error);
    showToast("Could not save on this device. Check available browser storage.", true);
  }
}

function initMap() {
  if (!window.L) {
    showToast("The map library did not load. Check your connection and refresh.", true);
    return;
  }
  map = window.L.map("map", { zoomControl: true }).setView([20, 0], 2);
  window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "",
  }).addTo(map);
  trackLayer = window.L.layerGroup().addTo(map);
  setTimeout(() => map.invalidateSize(), 100);
}

function haversineDistance(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDifference = radians(b.lat - a.lat);
  const longitudeDifference = radians(b.lng - a.lng);
  const latitudeA = radians(a.lat);
  const latitudeB = radians(b.lat);
  const chord = Math.sin(latitudeDifference / 2) ** 2
    + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDifference / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(chord), Math.sqrt(1 - chord));
}

function getPathDistance(path, closeLoop = false) {
  let distance = 0;
  for (let index = 1; index < path.length; index += 1) {
    distance += haversineDistance(path[index - 1], path[index]);
  }
  if (closeLoop && path.length > 2) distance += haversineDistance(path[path.length - 1], path[0]);
  return distance;
}

function getAreaSquareMeters(path) {
  if (path.length < 3) return 0;
  const centerLatitude = path.reduce((total, point) => total + point.lat, 0) / path.length;
  const metersPerDegreeLatitude = 111132.92 - 559.82 * Math.cos(2 * centerLatitude * Math.PI / 180)
    + 1.175 * Math.cos(4 * centerLatitude * Math.PI / 180);
  const metersPerDegreeLongitude = 111412.84 * Math.cos(centerLatitude * Math.PI / 180)
    - 93.5 * Math.cos(3 * centerLatitude * Math.PI / 180);
  const projected = path.map((point) => ({
    x: point.lng * metersPerDegreeLongitude,
    y: point.lat * metersPerDegreeLatitude,
  }));
  let twiceArea = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index];
    const next = projected[(index + 1) % projected.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

function formatDistance(meters) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} <small>km</small>`;
  return `${Math.round(meters)} <small>m</small>`;
}

function formatArea(squareMeters) {
  if (squareMeters < 1) return "0";
  if (squareMeters >= HECTARE_IN_SQUARE_METERS) return (squareMeters / HECTARE_IN_SQUARE_METERS).toFixed(2);
  return (squareMeters / ACRE_IN_SQUARE_METERS).toFixed(2);
}

function renderMetrics() {
  const area = getAreaSquareMeters(points);
  const distance = getPathDistance(points, trackingState === "finished");
  elements.area.textContent = points.length < 3 ? "—" : formatArea(area);
  elements.areaUnit.textContent = area >= HECTARE_IN_SQUARE_METERS ? "hectares" : "acres";
  elements.areaSecondary.textContent = points.length < 3
    ? "Walk at least 3 boundary points"
    : `${(area / ACRE_IN_SQUARE_METERS).toFixed(2)} acres · ${(area / HECTARE_IN_SQUARE_METERS).toFixed(2)} hectares`;
  elements.distance.innerHTML = formatDistance(distance);
  elements.accuracy.innerHTML = currentAccuracy === null
    ? "— <small>m</small>"
    : `${Math.round(currentAccuracy)} <small>m</small>`;
  elements.pointCount.textContent = `${points.length} ${points.length === 1 ? "point" : "points"}`;
  elements.finish.disabled = trackingState === "idle" || trackingState === "finished" || points.length < 3;
}

function renderMap(path = points, closeLoop = false, focusLatest = false) {
  if (!map || !trackLayer) return;
  trackLayer.clearLayers();
  elements.mapHelp.classList.toggle("dismissed", path.length > 0);
  if (path.length === 0) {
    elements.mapCaption.textContent = "Map ready";
    return;
  }
  const coordinates = path.map((point) => [point.lat, point.lng]);
  if (path.length > 1) {
    if (closeLoop && path.length >= 3) {
      window.L.polygon(coordinates, {
        color: "#477b58",
        weight: 3,
        opacity: 0.95,
        fillColor: "#7da87b",
        fillOpacity: 0.16,
        dashArray: "8 5",
      }).addTo(trackLayer);
    } else {
      window.L.polyline(coordinates, { color: "#477b58", weight: 3, opacity: 0.95 }).addTo(trackLayer);
    }
  }
  path.forEach((point, index) => {
    window.L.circleMarker([point.lat, point.lng], {
      radius: index === 0 ? 6 : 4,
      color: "#fff",
      weight: 2,
      fillColor: index === 0 ? "#d2775f" : "#568261",
      fillOpacity: 1,
    }).addTo(trackLayer);
  });
  elements.mapCaption.textContent = `${path.length} GPS ${path.length === 1 ? "point" : "points"} recorded`;
  if (focusLatest) {
    map.setView(coordinates[coordinates.length - 1], Math.max(map.getZoom(), 17), { animate: true });
  } else if (path.length > 1) {
    map.fitBounds(window.L.latLngBounds(coordinates), { padding: [55, 55], maxZoom: 17 });
  } else {
    map.setView(coordinates[0], 17, { animate: true });
  }
}

function setTrackingStatus(state, message) {
  trackingState = state;
  elements.statusText.textContent = message;
  elements.statusIndicator.className = `status-indicator${state === "recording" ? " recording" : state === "paused" ? " paused" : ""}`;
  elements.start.hidden = state === "recording";
  elements.pause.hidden = state === "idle" || state === "finished";
  elements.pause.querySelector("span").textContent = state === "paused" ? "Resume" : "Pause";
  elements.finish.textContent = "";
  const finishIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  finishIcon.setAttribute("viewBox", "0 0 24 24");
  finishIcon.setAttribute("fill", "currentColor");
  finishIcon.setAttribute("aria-hidden", "true");
  const finishRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  finishRect.setAttribute("x", "6");
  finishRect.setAttribute("y", "6");
  finishRect.setAttribute("width", "12");
  finishRect.setAttribute("height", "12");
  finishRect.setAttribute("rx", "2");
  finishIcon.append(finishRect);
  elements.finish.append(finishIcon, document.createTextNode(" Finish & save"));
  renderMetrics();
}

function showGpsError(error) {
  const messages = {
    1: "Location access is blocked. Allow location access in your browser settings to track a boundary.",
    2: "Your location is unavailable. Move outdoors and try again.",
    3: "GPS took too long to respond. Try again in an area with a clearer sky.",
  };
  const message = messages[error.code] || `Could not read GPS location: ${error.message || "unknown error"}`;
  elements.gpsMessage.textContent = message;
  showToast(message, true);
  if (trackingState === "recording" && points.length === 0) {
    stopWatch();
    setTrackingStatus("idle", "Ready when you are");
  }
}

function acceptPosition(position) {
  const { latitude, longitude, accuracy } = position.coords;
  currentAccuracy = accuracy;
  elements.gpsMessage.textContent = "";
  if (accuracy > MAX_GPS_ACCURACY_METERS) {
    elements.gpsMessage.textContent = `GPS accuracy is ±${Math.round(accuracy)} m. Waiting for a clearer signal (need ±${MAX_GPS_ACCURACY_METERS} m or better).`;
    renderMetrics();
    return;
  }
  const point = { lat: latitude, lng: longitude, accuracy, timestamp: position.timestamp };
  const lastPoint = points[points.length - 1];
  if (!lastPoint || haversineDistance(lastPoint, point) >= MIN_POINT_SPACING_METERS) {
    points.push(point);
    renderMap(points, false, true);
    renderMetrics();
  } else {
    renderMetrics();
  }
}

function startWatch() {
  if (!navigator.geolocation) {
    showToast("This browser does not support GPS location.", true);
    return;
  }
  if (!window.isSecureContext && location.hostname !== "localhost") {
    showToast("GPS requires a secure HTTPS connection. Open this site using HTTPS.", true);
    return;
  }
  elements.gpsMessage.textContent = "";
  setTrackingStatus("recording", "Waiting for GPS signal…");
  watchId = navigator.geolocation.watchPosition(
    (position) => {
      if (trackingState !== "recording") return;
      acceptPosition(position);
      if (points.length > 0) setTrackingStatus("recording", "Recording your boundary");
    },
    showGpsError,
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
  );
  elements.mapCaption.textContent = "Waiting for GPS signal";
}

function stopWatch() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function setSyncStatus(isCloud) {
  elements.syncLabel.classList.toggle("cloud", isCloud);
  elements.syncLabel.innerHTML = `<span class="sync-dot"></span>${isCloud ? "Synced to your account" : "Saved on this device"}`;
}

function updateHistory() {
  elements.history.replaceChildren();
  elements.historyCount.textContent = String(surveys.length);
  elements.clearHistory.hidden = surveys.length === 0;
  elements.exportHistory.hidden = surveys.length === 0;
  if (surveys.length === 0) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "Your completed walks will be saved here.";
    elements.history.append(empty);
    return;
  }
  surveys.slice(0, 8).forEach((survey) => {
    const entry = document.createElement("button");
    entry.type = "button";
    entry.className = "history-entry";
    entry.setAttribute("aria-label", `View ${survey.name}, ${formatSurveyArea(survey.area)} acres`);
    const info = document.createElement("span");
    info.className = "history-info";
    const name = document.createElement("span");
    name.className = "history-name";
    name.textContent = survey.name;
    const date = document.createElement("span");
    date.className = "history-date";
    date.textContent = new Date(survey.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const area = document.createElement("span");
    area.className = "history-area";
    area.textContent = `${formatSurveyArea(survey.area)} ac`;
    info.append(name, date);
    entry.append(info, area);
    entry.addEventListener("click", () => showSurvey(survey));
    elements.history.append(entry);
  });
}

function formatSurveyArea(squareMeters) {
  return (squareMeters / ACRE_IN_SQUARE_METERS).toFixed(2);
}

function showSurvey(survey) {
  points = survey.points;
  currentAccuracy = null;
  elements.nameInput.value = survey.name;
  setTrackingStatus("finished", "Saved survey");
  renderMap(points, true);
}

async function loadFirebase() {
  if (!firebaseConfig.apiKey || !firebaseConfig.authDomain || !firebaseConfig.projectId || !firebaseConfig.appId) return null;
  if (firebaseServices) return firebaseServices;
  const [{ initializeApp }, authModule, firestoreModule] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"),
    import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js"),
  ]);
  const app = initializeApp(firebaseConfig);
  firebaseServices = {
    auth: authModule.getAuth(app),
    GoogleAuthProvider: authModule.GoogleAuthProvider,
    signInWithPopup: authModule.signInWithPopup,
    signOut: authModule.signOut,
    onAuthStateChanged: authModule.onAuthStateChanged,
    db: firestoreModule.getFirestore(app),
    collection: firestoreModule.collection,
    getDocs: firestoreModule.getDocs,
    doc: firestoreModule.doc,
    setDoc: firestoreModule.setDoc,
    deleteDoc: firestoreModule.deleteDoc,
  };
  firebaseServices.onAuthStateChanged(firebaseServices.auth, (user) => {
    currentUser = user;
    elements.authLabel.textContent = user ? "Sign out" : "Continue with Google";
    setSyncStatus(Boolean(user));
    if (user) void syncSurveysFromCloud(user);
  });
  return firebaseServices;
}

async function syncSurveysFromCloud(user) {
  try {
    const services = await loadFirebase();
    const snapshot = await services.getDocs(services.collection(services.db, "users", user.uid, "surveys"));
    const cloudSurveys = snapshot.docs.map((entry) => entry.data());
    const cloudIds = new Set(cloudSurveys.map((survey) => survey.id));
    surveys = [
      ...cloudSurveys,
      ...surveys.filter((survey) => !survey.ownerUid && !cloudIds.has(survey.id)),
    ];
    persistLocalSurveys();
    updateHistory();
    setSyncStatus(true);
  } catch (error) {
    console.error("Could not sync surveys from Firebase:", error);
    showToast(`Signed in, but cloud sync failed: ${error.message}`, true);
  }
}

async function saveToCloud(survey, user = currentUser) {
  if (!user) return;
  const services = await loadFirebase();
  const cloudSurvey = { ...survey, ownerUid: user.uid };
  await services.setDoc(services.doc(services.db, "users", user.uid, "surveys", survey.id), cloudSurvey);
  Object.assign(survey, cloudSurvey);
}

async function toggleGoogleAuth() {
  try {
    const services = await loadFirebase();
    if (!services) {
      showToast("To enable Google sign-in, add your Firebase web app settings in firebase-config.js.", true);
      return;
    }
    if (currentUser) {
      await services.signOut(services.auth);
      currentUser = null;
      surveys = surveys.filter((survey) => !survey.ownerUid);
      persistLocalSurveys();
      updateHistory();
      elements.authLabel.textContent = "Continue with Google";
      setSyncStatus(Boolean(currentUser));
      showToast("Signed out. Your surveys remain saved on this device.");
      return;
    }
    const provider = new services.GoogleAuthProvider();
    await services.signInWithPopup(services.auth, provider);
  } catch (error) {
    console.error("Google sign-in failed:", error);
    const message = error.code === "auth/popup-blocked"
      ? "Your browser blocked the sign-in popup. Allow popups and try again."
      : error.code === "auth/unauthorized-domain"
        ? "Add this website's domain to Firebase Authentication's authorized domains."
        : error.message;
    showToast(`Google sign-in failed: ${message}`, true);
  }
}

async function finishSurvey() {
  if (points.length < 3) return;
  stopWatch();
  const now = new Date();
  const survey = {
    id: crypto.randomUUID(),
    name: elements.nameInput.value.trim() || `Boundary walk · ${now.toLocaleDateString()}`,
    createdAt: now.toISOString(),
    points,
    area: getAreaSquareMeters(points),
    perimeter: getPathDistance(points, true),
  };
  surveys = [survey, ...surveys];
  persistLocalSurveys();
  updateHistory();
  setTrackingStatus("finished", "Survey saved");
  renderMap(points, true);
  setSyncStatus(Boolean(currentUser));
  showToast("Boundary saved on this device.");
  if (currentUser) {
    try {
      await saveToCloud(survey);
      survey.ownerUid = currentUser.uid;
      persistLocalSurveys();
      setSyncStatus(true);
      showToast("Boundary saved and synced to your account.");
    } catch (error) {
      console.error("Could not save survey to Firebase:", error);
      showToast(`Saved on this device, but cloud sync failed: ${error.message}`, true);
    }
  }
}

async function clearSurvey() {
  const scope = currentUser ? "this device and your signed-in account" : "this device";
  if (!window.confirm(`Clear all saved surveys from ${scope}? This cannot be undone.`)) return;
  if (currentUser) {
    try {
      const services = await loadFirebase();
      const snapshot = await services.getDocs(services.collection(services.db, "users", currentUser.uid, "surveys"));
      await Promise.all(snapshot.docs.map((entry) => services.deleteDoc(entry.ref)));
    } catch (error) {
      console.error("Could not clear cloud surveys:", error);
      showToast(`Could not clear cloud surveys: ${error.message}`, true);
      return;
    }
  }
  surveys = [];
  persistLocalSurveys();
  updateHistory();
  showToast("Saved surveys cleared.");
}

function exportSurveys() {
  const file = new Blob([JSON.stringify({ format: "Fieldnote survey export", version: 1, surveys }, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = `fieldnote-surveys-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

elements.start.addEventListener("click", () => {
  if (trackingState === "idle" || trackingState === "finished") {
    points = [];
    currentAccuracy = null;
    elements.nameInput.value = "";
    renderMetrics();
    renderMap([]);
  }
  startWatch();
});
elements.pause.addEventListener("click", () => {
  if (trackingState === "recording") {
    stopWatch();
    setTrackingStatus("paused", "Walk paused");
    elements.mapCaption.textContent = "Tracking paused";
  } else if (trackingState === "paused") {
    startWatch();
  }
});
elements.finish.addEventListener("click", () => void finishSurvey());
elements.auth.addEventListener("click", () => void toggleGoogleAuth());
elements.clearHistory.addEventListener("click", clearSurvey);
elements.exportHistory.addEventListener("click", exportSurveys);
elements.locate.addEventListener("click", () => {
  if (!navigator.geolocation) {
    showToast("This browser does not support GPS location.", true);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      if (map) map.setView([coords.latitude, coords.longitude], 17, { animate: true });
    },
    showGpsError,
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
  );
});
window.addEventListener("beforeunload", stopWatch);

initMap();
renderMetrics();
updateHistory();
if (firebaseConfig.apiKey) {
  loadFirebase().catch((error) => {
    console.error("Could not initialize Firebase:", error);
    showToast(`Firebase could not be initialized: ${error.message}`, true);
  });
}
