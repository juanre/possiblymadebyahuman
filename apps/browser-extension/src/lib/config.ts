declare const __PMBAH_EXT_BASE_URL__: string;
declare const __PMBAH_EXT_RECORDS_ENDPOINT__: string;

export const DEFAULT_API_BASE_URL = "https://possiblymadebyahuman.com";

export function normalizeBaseUrl(raw: string | undefined): string {
  const candidate = raw && raw.trim().length > 0 ? raw.trim() : DEFAULT_API_BASE_URL;
  const parsed = new URL(candidate);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export const API_BASE_URL = normalizeBaseUrl(__PMBAH_EXT_BASE_URL__);
export const RECORDS_ENDPOINT = __PMBAH_EXT_RECORDS_ENDPOINT__;
