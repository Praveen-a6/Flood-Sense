// Native-app compatibility layer for FloodSense on Android (Capacitor).
//
// The SAME code runs on the web and inside the Android app. On the web every
// helper degrades to the standard browser API. Inside the app this module:
//   - routes navigator.geolocation through the native plugin, so the Android
//     runtime location permission dialog works (the bare WebView has none),
//   - maps navigator.wakeLock to a tiny native plugin, so the screen stays on
//     during navigation (the WebView has no Wake Lock API),
//   - remembers the optional FloodSense server address (admin-prepared packs +
//     weather proxy; the app works fully without one),
//   - asks Android to keep our offline maps safe from storage eviction.
//
// Node-safe: every browser global is guarded, so the test suite can import
// the modules that depend on this one.

// The Capacitor bridge global, read at CALL time: in the Android app it is
// injected before any module loads, and reading late keeps this shim testable
// outside a WebView (and safe if the bridge ever appears late).
const cap = () => globalThis.Capacitor ?? null;
const nav = typeof navigator !== "undefined" ? navigator : null;

/** True inside the installed Android app. */
export const isNative = () => {
  const Cap = cap();
  return !!(Cap?.isNativePlatform?.() && Cap.isNativePlatform());
};

// ------------------------------------------------------------------ server
const SERVER_KEY = "floodsense.server";

/** The optional FloodSense server address ("" = none / same origin on the web). */
export function serverUrl() {
  try { return (localStorage.getItem(SERVER_KEY) || "").trim(); } catch { return ""; }
}
export function setServerUrl(u) {
  const v = (u || "").trim().replace(/\/+$/, "");
  try { v ? localStorage.setItem(SERVER_KEY, v) : localStorage.removeItem(SERVER_KEY); } catch { /* private mode */ }
  return v;
}
export const hasServer = () => !!serverUrl();

/** Prefix an /api path with the configured server when running as the app.
 *  On the web the path stays relative (same origin as the page). */
export function apiUrl(path) {
  if (!isNative()) return path;
  const base = serverUrl();
  return base ? base + path : path;
}

// ------------------------------------------------------------------ install
function patchGeolocation() {
  const Cap = cap();
  const geo = Cap?.Plugins?.Geolocation;
  if (!geo || !nav) return;
  let seq = 0;
  const watches = new Map();   // web-style handle -> plugin watch id
  nav.geolocation = {
    getCurrentPosition(ok, err, opts = {}) {
      geo.getCurrentPosition({
        enableHighAccuracy: opts.enableHighAccuracy !== false,
        timeout: opts.timeout ?? 10000,
        maximumAge: opts.maximumAge ?? 60000,
      }).then(ok).catch((e) => err?.(new Error(e?.message || "GPS unavailable")));
    },
    watchPosition(ok, err, opts = {}) {
      const token = ++seq;
      geo.watchPosition({
        enableHighAccuracy: opts.enableHighAccuracy !== false,
        timeout: opts.timeout ?? 15000,
        maximumAge: opts.maximumAge ?? 1000,
      }, (pos, e) => { if (e) err?.(new Error(e?.message || "GPS unavailable")); else ok(pos); })
        .then((id) => watches.set(token, id))
        .catch((e) => err?.(new Error(e?.message || "GPS unavailable")));
      return token;
    },
    clearWatch(token) {
      const id = watches.get(token);
      watches.delete(token);
      if (id != null) geo.clearWatch({ id }).catch(() => {});
    },
  };
}

function patchWakeLock() {
  const Cap = cap();
  const keep = Cap?.Plugins?.KeepAwake;
  if (!keep || !nav || nav.wakeLock) return;
  nav.wakeLock = {
    request: async () => {
      await keep.enable();
      return { release: async () => { try { await keep.disable(); } catch { /* already off */ } } };
    },
  };
}

/** Install every native shim. Call once at app start; a no-op on the web. */
export function installNativeCompat() {
  if (!isNative()) return;
  patchGeolocation();
  patchWakeLock();
  try { nav?.storage?.persist?.().catch?.(() => {}); } catch { /* not granted */ }
}
