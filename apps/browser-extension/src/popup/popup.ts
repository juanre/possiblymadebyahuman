import { API_BASE_URL } from "../lib/config.ts";

const root = document.getElementById("app");
if (root) {
  root.textContent = `possiblymadebyahuman extension packaging scaffold. API: ${API_BASE_URL}`;
}
