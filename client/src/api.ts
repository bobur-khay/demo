export type TelemetryValue = number | string | boolean | null;

export interface TelemetryPoint {
  deviceId: string;
  metric: string;
  value: TelemetryValue;
  timestamp: string;
  source: "mock" | "wot" | "influx";
}

export interface MetricDefinition {
  name: string;
  title: string;
  kind: "event" | "property";
  value_type: string;
  unit: string | null;
  minimum: number | null;
  maximum: number | null;
  semantic_type: string | null;
}

export interface DeviceDefinition {
  id: string;
  title: string;
  description: string;
  connected: boolean;
  metrics: MetricDefinition[];
  latest: Record<string, TelemetryPoint>;
}

export interface HealthStatus {
  status: "ok" | "degraded";
  dataSource: "mock" | "wot";
  influx: "disabled" | "connected" | "error";
  deviceCount: number;
  connectedCount: number;
  pollIntervalSeconds: number;
}

export interface DeviceHistory {
  deviceId: string;
  series: Record<string, TelemetryPoint[]>;
}

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.PROD ? window.location.origin : "http://localhost:8000")
).replace(/\/$/, "");

async function request<T>(
  path: string,
  signal?: AbortSignal,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, { ...init, signal });
  if (!response.ok) {
    throw new Error(`API request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function getHealth(signal?: AbortSignal) {
  return request<HealthStatus>("/api/health", signal);
}

export function getDevices(signal?: AbortSignal) {
  return request<DeviceDefinition[]>("/api/devices", signal);
}

export function setDeviceConnection(
  deviceId: string,
  connected: boolean,
  signal?: AbortSignal,
) {
  return request<DeviceDefinition>(
    `/api/devices/${encodeURIComponent(deviceId)}/connection`,
    signal,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connected }),
    },
  );
}

export function getDeviceHistory(
  deviceId: string,
  metrics: string[],
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ metrics: metrics.join(",") });
  return request<DeviceHistory>(
    `/api/devices/${encodeURIComponent(deviceId)}/history?${query}`,
    signal,
  );
}

export function deviceSocketUrl(deviceId: string) {
  const url = new URL(API_BASE_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/ws/devices/${encodeURIComponent(deviceId)}`;
  return url.toString();
}
