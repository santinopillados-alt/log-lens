/**
 * API client — single source of truth for all backend calls.
 * Uses native fetch (no axios) to keep the bundle lean.
 */
const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(error.detail || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  analyze: (content, serviceName) =>
    request("/api/analyze", {
      method: "POST",
      body: JSON.stringify({ content, service_name: serviceName }),
    }),

  getHistory: (params = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null))
    ).toString();
    return request(`/api/history${qs ? `?${qs}` : ""}`);
  },

  getAnalysis: (id) => request(`/api/analysis/${id}`),

  clearHistory: () => request("/api/history", { method: "DELETE" }),
};
