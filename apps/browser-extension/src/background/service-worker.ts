import { API_BASE_URL, RECORDS_ENDPOINT } from "../lib/config.ts";

export const BACKGROUND_ENTRYPOINT = "service-worker";

// Packaging scaffold only. default-aaaa.7 owns capture/session behavior.
console.info("possiblymadebyahuman extension service worker loaded", { apiBaseUrl: API_BASE_URL, recordsEndpoint: RECORDS_ENDPOINT });
