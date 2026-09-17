import { useEffect, useState } from "react";
import { deviceSocketUrl } from "./api";
import type { TelemetryPoint } from "./api";

export type StreamStatus = "connecting" | "live" | "offline";

interface StreamMessage {
  type: "snapshot" | "telemetry";
  data: Record<string, TelemetryPoint> | TelemetryPoint;
}

export function useDeviceStream(
  deviceId: string | undefined,
  initial: Record<string, TelemetryPoint> = {},
) {
  const [state, setState] = useState<{
    deviceId?: string;
    latest: Record<string, TelemetryPoint>;
    status: StreamStatus;
    lastMessageAt?: string;
  }>({
    deviceId,
    latest: initial,
    status: deviceId ? "connecting" : "offline",
  });

  useEffect(() => {
    if (!deviceId) return;

    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;

    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(deviceSocketUrl(deviceId));

      socket.onopen = () => {
        reconnectAttempt = 0;
        setState((current) => ({
          deviceId,
          latest: current.deviceId === deviceId ? current.latest : initial,
          status: "live",
          lastMessageAt:
            current.deviceId === deviceId ? current.lastMessageAt : undefined,
        }));
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as StreamMessage;
        const receivedAt = new Date().toISOString();
        if (message.type === "snapshot") {
          setState({
            deviceId,
            latest: message.data as Record<string, TelemetryPoint>,
            status: "live",
            lastMessageAt: receivedAt,
          });
          return;
        }
        const point = message.data as TelemetryPoint;
        setState((current) => ({
          deviceId,
          latest: {
            ...(current.deviceId === deviceId ? current.latest : initial),
            [point.metric]: point,
          },
          status: "live",
          lastMessageAt: receivedAt,
        }));
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (disposed) return;
        setState((current) => ({
          deviceId,
          latest: current.deviceId === deviceId ? current.latest : initial,
          status: "offline",
          lastMessageAt:
            current.deviceId === deviceId ? current.lastMessageAt : undefined,
        }));
        const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [deviceId, initial]);

  if (!deviceId) {
    return {
      latest: initial,
      status: "offline" as const,
      lastMessageAt: undefined,
    };
  }
  if (state.deviceId !== deviceId) {
    return {
      latest: initial,
      status: "connecting" as const,
      lastMessageAt: undefined,
    };
  }
  return state;
}
