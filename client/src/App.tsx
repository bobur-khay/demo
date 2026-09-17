import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BatteryMedium,
  Cloud,
  Droplets,
  Gauge,
  Radio,
  RefreshCw,
  Server,
  Thermometer,
  Waves,
  Zap,
} from "lucide-react";
import {
  getDeviceHistory,
  getDevices,
  getHealth,
  type DeviceDefinition,
  type HealthStatus,
  type MetricDefinition,
  type TelemetryPoint,
} from "./api";
import { useDeviceStream, type StreamStatus } from "./useDeviceStream";
import "./App.css";

type RangeDays = 1 | 7 | 30;
type PhaseGroup = "voltage" | "current" | "power";

const TrendChart = lazy(() => import("./TrendChart"));
const EMPTY_LATEST: Record<string, TelemetryPoint> = {};
const EMPTY_HISTORY: Record<string, TelemetryPoint[]> = {};
const CHART_COLORS = ["#087f78", "#d79721", "#315e8a", "#b84c3f"];
const PHASE_GROUPS: Record<PhaseGroup, string[]> = {
  voltage: ["voltage-l1-n", "voltage-l2-n", "voltage-l3-n"],
  current: ["current-l1", "current-l2", "current-l3"],
  power: ["apparent-power-l1", "apparent-power-l2", "apparent-power-l3"],
};

function normalizeUnit(unit: string | null) {
  const units: Record<string, string> = {
    Cel: "°C",
    "qunit:V": "V",
    "qunit:A": "A",
    "qunit:V-A": "VA",
    "%RH": "% RH",
  };
  return unit ? units[unit] || unit.replace("qunit:", "") : "";
}

function formatValue(value: TelemetryPoint["value"], unit: string | null) {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "number") return String(value);
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  const formatted = value.toLocaleString(undefined, {
    maximumFractionDigits: digits,
  });
  return `${formatted}${normalizeUnit(unit) ? ` ${normalizeUnit(unit)}` : ""}`;
}

function relativeTime(timestamp?: string) {
  if (!timestamp) return "Awaiting data";
  const seconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(timestamp)) / 1000),
  );
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function metricIcon(metric: MetricDefinition) {
  const name = metric.name.toLowerCase();
  if (name.includes("temperature")) return Thermometer;
  if (name.includes("battery")) return BatteryMedium;
  if (name.includes("humidity")) return Droplets;
  if (
    name.includes("voltage") ||
    name.includes("power") ||
    name.includes("current")
  )
    return Zap;
  return Activity;
}

function deviceIcon(device: DeviceDefinition) {
  const name = `${device.id} ${device.title}`.toLowerCase();
  if (name.includes("sentron")) return Zap;
  if (name.includes("milesight")) return Waves;
  if (name.includes("netvox")) return Radio;
  return Gauge;
}

function streamLabel(status: StreamStatus) {
  if (status === "live") return "Live stream";
  if (status === "connecting") return "Connecting";
  return "Reconnecting";
}

function buildChartData(
  series: Record<string, TelemetryPoint[]>,
  metrics: string[],
  rangeDays: RangeDays,
) {
  const cutoff = Date.now() - rangeDays * 24 * 60 * 60 * 1000;
  const rows = new Map<number, Record<string, number | string>>();

  metrics.forEach((metric) => {
    const eligible = (series[metric] || []).filter(
      (point) =>
        typeof point.value === "number" &&
        Date.parse(point.timestamp) >= cutoff,
    );
    const step = Math.max(1, Math.ceil(eligible.length / 360));
    eligible.forEach((point, index) => {
      if (index % step !== 0 && index !== eligible.length - 1) return;
      const timestamp = Date.parse(point.timestamp);
      const row = rows.get(timestamp) || { timestamp };
      row[metric] = point.value as number;
      rows.set(timestamp, row);
    });
  });

  return [...rows.values()].sort(
    (left, right) => Number(left.timestamp) - Number(right.timestamp),
  );
}

function StatusDot({ status }: { status: StreamStatus }) {
  return <span className={`status-dot ${status}`} aria-hidden="true" />;
}

function App() {
  const [devices, setDevices] = useState<DeviceDefinition[]>([]);
  const [health, setHealth] = useState<HealthStatus>();
  const [selectedId, setSelectedId] = useState<string>();
  const [historyState, setHistoryState] = useState<{
    deviceId?: string;
    series: Record<string, TelemetryPoint[]>;
  }>({ series: {} });
  const [error, setError] = useState<string>();
  const [rangeDays, setRangeDays] = useState<RangeDays>(7);
  const [phaseGroup, setPhaseGroup] = useState<PhaseGroup>("voltage");
  const eventRef = useRef<HTMLUiEventElement>(null);
  const notificationRef = useRef<HTMLUiNotificationElement>(null);
  const lastLeakEvent = useRef<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const [nextDevices, nextHealth] = await Promise.all([
          getDevices(controller.signal),
          getHealth(controller.signal),
        ]);
        setDevices(nextDevices);
        setHealth(nextHealth);
        setSelectedId((current) => current || nextDevices[0]?.id);
        setError(undefined);
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Unable to load devices",
          );
        }
      }
    };
    void load();
    const interval = window.setInterval(() => {
      void getHealth(controller.signal)
        .then(setHealth)
        .catch(() => undefined);
    }, 30000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  const selectedDevice = devices.find((device) => device.id === selectedId);
  const selectedInitial = selectedDevice?.latest || EMPTY_LATEST;
  const selectedStream = useDeviceStream(selectedDevice?.id, selectedInitial);
  const leakageDevice = devices.find((device) =>
    device.metrics.some((metric) => metric.name === "leakage_status"),
  );
  const independentLeakDeviceId =
    leakageDevice?.id === selectedDevice?.id ? undefined : leakageDevice?.id;
  const leakageInitial = leakageDevice?.latest || EMPTY_LATEST;
  const leakageStream = useDeviceStream(
    independentLeakDeviceId,
    leakageInitial,
  );
  const leakageLatest = independentLeakDeviceId
    ? leakageStream.latest
    : selectedStream.latest;
  const leakageStatus = independentLeakDeviceId
    ? leakageStream.status
    : selectedStream.status;
  const leakagePoint = leakageLatest.leakage_status;
  const hasLeak = String(leakagePoint?.value).toLowerCase() === "leak";
  const isSentron = selectedDevice?.metrics.some(
    (metric) => metric.name === "current-l1",
  );

  const historyMetrics = useMemo(() => {
    if (!selectedDevice) return [];
    if (isSentron) return Object.values(PHASE_GROUPS).flat();
    return selectedDevice.metrics
      .filter((metric) => ["number", "integer"].includes(metric.value_type))
      .slice(0, 4)
      .map((metric) => metric.name);
  }, [isSentron, selectedDevice]);

  useEffect(() => {
    if (!selectedDevice || historyMetrics.length === 0) {
      return;
    }
    const controller = new AbortController();
    getDeviceHistory(selectedDevice.id, historyMetrics, controller.signal)
      .then((response) => {
        setHistoryState({
          deviceId: response.deviceId,
          series: response.series,
        });
        setError(undefined);
      })
      .catch((historyError) => {
        if (!controller.signal.aborted) {
          setError(
            historyError instanceof Error
              ? historyError.message
              : "History unavailable",
          );
        }
      });
    return () => controller.abort();
  }, [historyMetrics, selectedDevice]);

  useEffect(() => {
    const eventElement = eventRef.current;
    if (!eventElement) return;
    void eventElement.startListening();
    void eventElement.setStatus(
      leakageStatus === "live"
        ? "success"
        : leakageStatus === "connecting"
          ? "loading"
          : "error",
      leakageStatus === "offline" ? "Leakage stream unavailable" : undefined,
    );
    if (
      leakagePoint?.timestamp &&
      lastLeakEvent.current !== leakagePoint.timestamp
    ) {
      lastLeakEvent.current = leakagePoint.timestamp;
      void eventElement.addEvent(
        { state: leakagePoint.value, device: leakageDevice?.title },
        leakagePoint.timestamp,
      );
    }
  }, [leakageDevice?.title, leakagePoint, leakageStatus]);

  useEffect(() => {
    const notification = notificationRef.current;
    if (!notification) return;
    if (hasLeak) {
      notification.message = "Leak detected by Milesight EM300-ZLD";
      notification.type = "warning";
      void notification.show();
    } else {
      void notification.dismiss();
    }
  }, [hasLeak]);

  const chartMetrics = isSentron
    ? PHASE_GROUPS[phaseGroup]
    : historyMetrics.slice(0, 3);
  const history =
    historyState.deviceId === selectedDevice?.id
      ? historyState.series
      : EMPTY_HISTORY;
  const historyLoading = Boolean(
    selectedDevice &&
    historyMetrics.length &&
    historyState.deviceId !== selectedDevice.id,
  );
  const chartData = useMemo(
    () => buildChartData(history, chartMetrics, rangeDays),
    [chartMetrics, history, rangeDays],
  );
  const metricByName = new Map(
    selectedDevice?.metrics.map((metric) => [metric.name, metric]) || [],
  );
  const latestTimestamp = Object.values(selectedStream.latest)
    .map((point) => point.timestamp)
    .sort()
    .at(-1);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Activity size={19} />
          </span>
          <span>WoT Operations</span>
        </div>

        <nav className="device-nav" aria-label="Devices">
          <p className="nav-label">
            Devices <span>{devices.length}</span>
          </p>
          {devices.map((device) => {
            const Icon = deviceIcon(device);
            return (
              <button
                className={
                  device.id === selectedId
                    ? "device-link active"
                    : "device-link"
                }
                key={device.id}
                onClick={() => setSelectedId(device.id)}
                type="button"
              >
                <Icon size={18} />
                <span>
                  <strong>{device.title}</strong>
                  <small>{device.metrics.length} signals</small>
                </span>
                <span className="online-dot" aria-label="Available" />
              </button>
            );
          })}
        </nav>

        <div className="system-card">
          <div>
            <Server size={16} />
            <span>Data source</span>
            <strong>{health?.dataSource || "—"}</strong>
          </div>
          <div>
            <Cloud size={16} />
            <span>InfluxDB</span>
            <strong>{health?.influx || "—"}</strong>
          </div>
        </div>
      </aside>

      <main className="dashboard">
        <header className="topbar">
          <div>
            <p className="eyebrow">Facility telemetry</p>
            <h1>Device dashboard</h1>
          </div>
          <div className={`connection-pill ${selectedStream.status}`}>
            <StatusDot status={selectedStream.status} />
            <span>{streamLabel(selectedStream.status)}</span>
            <small>{health?.pollIntervalSeconds || 2}s cadence</small>
          </div>
        </header>

        {error && (
          <div className="error-banner" role="alert">
            <AlertTriangle size={18} />
            <span>{error}</span>
            <button
              type="button"
              onClick={() => window.location.reload()}
              aria-label="Retry"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        )}

        <section className="overview-grid">
          <div className="device-heading">
            <div className="device-kicker">
              <span>Selected device</span>
              <strong>{selectedDevice?.metrics.length || 0} metrics</strong>
            </div>
            <h2>{selectedDevice?.title || "Loading devices"}</h2>
            <p>
              {selectedDevice?.description ||
                "Connecting to telemetry service…"}
            </p>
            <div className="device-meta">
              <span>
                <Radio size={15} /> {streamLabel(selectedStream.status)}
              </span>
              <span>
                <RefreshCw size={15} /> Updated {relativeTime(latestTimestamp)}
              </span>
            </div>
          </div>

          <div className={hasLeak ? "leak-panel alerting" : "leak-panel"}>
            <div className="leak-icon">
              <Droplets size={24} />
            </div>
            <div className="leak-copy">
              <span>Milesight leakage</span>
              <strong>{hasLeak ? "Leak detected" : "No leakage"}</strong>
              <small>{relativeTime(leakagePoint?.timestamp)}</small>
            </div>
            <div
              className="leak-state"
              aria-label={hasLeak ? "Warning" : "Normal"}
            >
              {hasLeak ? (
                <AlertTriangle size={18} />
              ) : (
                <span className="checkmark">✓</span>
              )}
            </div>
          </div>
        </section>

        <section className="metrics-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Current readings</p>
              <h2>Live metrics</h2>
            </div>
            <span>
              {latestTimestamp
                ? new Date(latestTimestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })
                : "Waiting"}
            </span>
          </div>
          <div className="metric-grid">
            {selectedDevice?.metrics.map((metric) => {
              const Icon = metricIcon(metric);
              const point = selectedStream.latest[metric.name];
              const warning = metric.name === "leakage_status" && hasLeak;
              return (
                <article
                  className={warning ? "metric-card warning" : "metric-card"}
                  key={metric.name}
                >
                  <div className="metric-top">
                    <span>{metric.title}</span>
                    <Icon size={17} />
                  </div>
                  <strong>{formatValue(point?.value, metric.unit)}</strong>
                  <small>
                    {relativeTime(point?.timestamp)} · {metric.kind}
                  </small>
                </article>
              );
            })}
          </div>
        </section>

        <section className="analytics-grid">
          <div className="chart-panel">
            <div className="section-heading chart-heading">
              <div>
                <p className="eyebrow">Historical telemetry</p>
                <h2>{isSentron ? "Three-phase trend" : "Signal trend"}</h2>
              </div>
              <div className="range-control" aria-label="History range">
                {([1, 7, 30] as RangeDays[]).map((days) => (
                  <button
                    key={days}
                    className={rangeDays === days ? "active" : ""}
                    type="button"
                    onClick={() => setRangeDays(days)}
                  >
                    {days === 1 ? "24H" : `${days}D`}
                  </button>
                ))}
              </div>
            </div>

            {isSentron && (
              <div
                className="phase-tabs"
                role="tablist"
                aria-label="Electrical measurement"
              >
                {(["voltage", "current", "power"] as PhaseGroup[]).map(
                  (group) => (
                    <button
                      role="tab"
                      aria-selected={phaseGroup === group}
                      className={phaseGroup === group ? "active" : ""}
                      key={group}
                      type="button"
                      onClick={() => setPhaseGroup(group)}
                    >
                      {group}
                    </button>
                  ),
                )}
              </div>
            )}

            <div className="chart-wrap">
              {historyLoading ? (
                <div className="chart-empty">
                  <RefreshCw className="spin" size={22} /> Loading history
                </div>
              ) : chartData.length ? (
                <Suspense
                  fallback={
                    <div className="chart-empty">
                      <RefreshCw className="spin" size={22} /> Loading chart
                    </div>
                  }
                >
                  <TrendChart
                    colors={CHART_COLORS}
                    data={chartData}
                    metrics={chartMetrics.map((metric) => ({
                      key: metric,
                      label: metricByName.get(metric)?.title || metric,
                    }))}
                  />
                </Suspense>
              ) : (
                <div className="chart-empty">
                  No numeric history in this range
                </div>
              )}
            </div>
          </div>

          <aside className="events-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Thingweb UI-WoT</p>
                <h2>Leakage events</h2>
              </div>
              <StatusDot status={leakageStatus} />
            </div>
            <ui-event
              ref={eventRef}
              event-name="leakage_status"
              label="Milesight EM300-ZLD"
              max-events={5}
              show-last-updated
              show-status
              show-timestamp
              variant="outlined"
            />
          </aside>
        </section>
      </main>

      <div className="notification-host">
        <ui-notification
          ref={notificationRef}
          duration={0}
          message=""
          show-close-button
          show-icon
          type="warning"
        />
      </div>
    </div>
  );
}

export default App;
