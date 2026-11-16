import { buildNearbyPack } from "./live_pack.js";

self.onmessage = async (event) => {
  try {
    const pack = await buildNearbyPack(event.data.lat, event.data.lon,
      (message) => self.postMessage({ type: "progress", message }));
    self.postMessage({ type: "complete", pack });
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message || String(error) });
  }
};
