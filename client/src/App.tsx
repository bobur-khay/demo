import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  Activity,
  AlertTriangle,
  BatteryMedium,
  Cloud,
  Droplets,
  FileJson,
  Gauge,
  LayoutDashboard,
  Radio,
  RefreshCw,
  Server,
  Thermometer,
  Unplug,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  getDeviceHistory,
  getDevices,
  getHealth,
  setDeviceConnection,
  type DeviceDefinition,
  type HealthStatus,
  type MetricDefinition,
  type TelemetryPoint,
} from "./api";
import { useDeviceStream, type StreamStatus } from "./useDeviceStream";
import "./App.css";
import thingwebLogo from "../public/thingweb-logo.png";

type RangeDays = 1 | 7 | 30;
type PhaseGroup = "voltage" | "current" | "power";
type View = "dashboard" | "device";

const TrendChart = lazy(() => import("./TrendChart"));
const EMPTY_LATEST: Record<string, TelemetryPoint> = {};
const EMPTY_HISTORY: Record<string, TelemetryPoint[]> = {};
const CHART_COLORS = ["#33b8a4", "#d65cab", "#e09f3e", "#5fd3c1"];
const PHASE_GROUPS: Record<PhaseGroup, string[]> = {
  voltage: ["voltage-l1-n", "voltage-l2-n", "voltage-l3-n"],
  current: ["current-l1", "current-l2", "current-l3"],
  power: ["apparent-power-l1", "apparent-power-l2", "apparent-power-l3"],
};
const MEASUREMENT_GROUPS: {
  key: string;
  label: string;
  icon: LucideIcon;
  match: (name: string) => boolean;
}[] = [
  {
    key: "temperature",
    label: "Temperature",
    icon: Thermometer,
    match: (name) => name.includes("temperature"),
  },
  {
    key: "humidity",
    label: "Humidity",
    icon: Droplets,
    match: (name) => name.includes("humidity"),
  },
  {
    key: "battery",
    label: "Battery",
    icon: BatteryMedium,
    match: (name) => name.includes("battery"),
  },
  {
    key: "voltage",
    label: "Voltage",
    icon: Zap,
    match: (name) => name.startsWith("voltage"),
  },
  {
    key: "current",
    label: "Current",
    icon: Activity,
    match: (name) => name.startsWith("current"),
  },
  {
    key: "power",
    label: "Power",
    icon: Gauge,
    match: (name) => name.includes("power"),
  },
];

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

function lastSeen(device: DeviceDefinition) {
  return Object.values(device.latest)
    .map((point) => point.timestamp)
    .sort()
    .at(-1);
}

interface MeasurementAverage {
  key: string;
  label: string;
  icon: LucideIcon;
  unit: string | null;
  average: number;
  signalCount: number;
  deviceCount: number;
}

function buildAverages(devices: DeviceDefinition[]): MeasurementAverage[] {
  const buckets = new Map<
    string,
    Omit<MeasurementAverage, "average" | "deviceCount"> & {
      total: number;
      deviceIds: Set<string>;
    }
  >();

  devices.forEach((device) => {
    device.metrics.forEach((metric) => {
      const group = MEASUREMENT_GROUPS.find((candidate) =>
        candidate.match(metric.name.toLowerCase()),
      );
      const value = device.latest[metric.name]?.value;
      if (!group || typeof value !== "number" || !Number.isFinite(value)) {
        return;
      }
      // Same quantity reported in different units must not be averaged together.
      const key = `${group.key}|${normalizeUnit(metric.unit)}`;
      const bucket = buckets.get(key) || {
        key,
        label: group.label,
        icon: group.icon,
        unit: metric.unit,
        total: 0,
        signalCount: 0,
        deviceIds: new Set<string>(),
      };
      bucket.total += value;
      bucket.signalCount += 1;
      bucket.deviceIds.add(device.id);
      buckets.set(key, bucket);
    });
  });

  return [...buckets.values()].map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    icon: bucket.icon,
    unit: bucket.unit,
    average: bucket.total / bucket.signalCount,
    signalCount: bucket.signalCount,
    deviceCount: bucket.deviceIds.size,
  }));
}

function StatusDot({ status }: { status: StreamStatus }) {
  return <span className={`status-dot ${status}`} aria-hidden="true" />;
}

const TD_FILE_PATTERN = /\.(td\.)?json(ld)?$/i;

// Only the dropped file name is inspected; its contents are never read.
function titleFromFileName(fileName: string) {
  return fileName.replace(TD_FILE_PATTERN, "").trim();
}

function titlesMatch(fileTitle: string, deviceTitle: string) {
  return (
    fileTitle.localeCompare(deviceTitle.trim(), undefined, {
      sensitivity: "accent",
    }) === 0
  );
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
  const [view, setView] = useState<View>("dashboard");
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [detachTarget, setDetachTarget] = useState<DeviceDefinition>();
  const [dropZone, setDropZone] = useState<string>();
  const [onboardError, setOnboardError] = useState<string>();
  const eventRef = useRef<HTMLUiEventElement>(null);
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
        setSelectedId(
          (current) =>
            current || nextDevices.find((device) => device.connected)?.id,
        );
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

  useEffect(() => {
    if (view !== "dashboard") return;
    const controller = new AbortController();
    const interval = window.setInterval(() => {
      void getDevices(controller.signal)
        .then(setDevices)
        .catch(() => undefined);
    }, 10000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [view]);

  const selectedDevice = devices.find(
    (device) => device.id === selectedId && device.connected,
  );
  const selectedInitial = selectedDevice?.latest || EMPTY_LATEST;
  const selectedStream = useDeviceStream(selectedDevice?.id, selectedInitial);
  const connectedDevices = useMemo(
    () => devices.filter((device) => device.connected),
    [devices],
  );
  const leakageDevice = connectedDevices.find((device) =>
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
    const eventElement = eventRef.current;
    if (!eventElement) return;
    let cancelled = false;
    void customElements.whenDefined("ui-event").then(() => {
      const shadow = eventElement.shadowRoot;
      if (
        cancelled ||
        !shadow ||
        shadow.querySelector("style[data-hide-controls]")
      ) {
        return;
      }
      const style = document.createElement("style");
      style.dataset.hideControls = "true";
      // ui-event exposes no prop to hide its subscribe/unsubscribe controls.
      style.textContent = ".gap-2.mb-3 { display: none; }";
      shadow.append(style);
    });
    return () => {
      cancelled = true;
    };
  }, [view]);

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
  const averages = useMemo(
    () => buildAverages(connectedDevices),
    [connectedDevices],
  );
  const signalCount = connectedDevices.reduce(
    (total, device) => total + device.metrics.length,
    0,
  );
  const readingCount = connectedDevices.reduce(
    (total, device) => total + Object.keys(device.latest).length,
    0,
  );
  const detachedCount = devices.length - connectedDevices.length;

  useEffect(() => {
    if (view === "device" && devices.length > 0 && !selectedDevice) {
      setView("dashboard");
    }
  }, [devices.length, selectedDevice, view]);

  useEffect(() => {
    // Without this the browser opens a file dropped outside the onboard zone.
    const prevent = (event: Event) => event.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  const alerts = useMemo(() => {
    const active: {
      id: string;
      title: string;
      device: string;
      timestamp?: string;
    }[] = [];
    connectedDevices.forEach((device) => {
      // The leakage device is streamed live, so prefer its socket value.
      const point =
        device.id === leakageDevice?.id
          ? leakagePoint
          : device.latest.leakage_status;
      if (String(point?.value).toLowerCase() === "leak") {
        active.push({
          id: `${device.id}:leakage`,
          title: "Leak detected",
          device: device.title,
          timestamp: point?.timestamp,
        });
      }
    });
    return active;
  }, [connectedDevices, leakageDevice?.id, leakagePoint]);

  const setConnection = useCallback(
    async (device: DeviceDefinition, connected: boolean) => {
      setPendingIds((current) => [...current, device.id]);
      try {
        const updated = await setDeviceConnection(device.id, connected);
        setDevices((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
        setError(undefined);
        return true;
      } catch (connectionError) {
        setError(
          connectionError instanceof Error
            ? connectionError.message
            : "Unable to change device connection",
        );
        return false;
      } finally {
        setPendingIds((current) => current.filter((id) => id !== device.id));
      }
    },
    [],
  );

  const confirmDetach = async () => {
    if (!detachTarget) return;
    const device = detachTarget;
    setDetachTarget(undefined);
    const removed = await setConnection(device, false);
    // A detached device is gone from the UI, so its detail view must close.
    if (removed && selectedId === device.id) {
      setView("dashboard");
      setSelectedId(undefined);
    }
  };

  const onboardFromFiles = useCallback(
    (files: FileList | null) => {
      const dropped = [...(files || [])];
      if (dropped.length === 0) return;

      const matches: DeviceDefinition[] = [];
      const rejected: string[] = [];
      dropped.forEach((file) => {
        if (!TD_FILE_PATTERN.test(file.name)) {
          rejected.push(`"${file.name}" is not a JSON Thing Description file.`);
          return;
        }
        const fileTitle = titleFromFileName(file.name);
        const known = devices.filter((device) =>
          titlesMatch(fileTitle, device.title),
        );
        if (known.length === 0) {
          rejected.push(
            `Could not onboard the device from file "${file.name}"`,
          );
          return;
        }
        const match = known.find(
          (device) =>
            !device.connected &&
            // A device already matched by an earlier file must not be reused.
            !matches.some((picked) => picked.id === device.id),
        );
        if (!match) {
          rejected.push(`"${known[0].title}" is already onboarded.`);
          return;
        }
        matches.push(match);
      });

      setOnboardError(rejected.length > 0 ? rejected.join(" ") : undefined);
      matches.forEach((match) => {
        void setConnection(match, true);
      });
    },
    [devices, setConnection],
  );

  const renderOnboardZone = (zone: string, heading: string) => (
    <div
      className={dropZone === zone ? "onboard-zone active" : "onboard-zone"}
      onDragEnter={(event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        setDropZone(zone);
      }}
      onDragOver={(event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        setDropZone(zone);
      }}
      onDragLeave={(event: DragEvent<HTMLElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDropZone((current) => (current === zone ? undefined : current));
      }}
      onDrop={(event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        setDropZone(undefined);
        onboardFromFiles(event.dataTransfer.files);
      }}
    >
      <span className="onboard-zone-icon">
        <FileJson size={16} />
      </span>
      <strong>{heading}</strong>
      {onboardError ? (
        <p className="onboard-zone-error" role="alert">
          {onboardError}
        </p>
      ) : null}
    </div>
  );

  const renderDetachButton = (device: DeviceDefinition, className: string) => {
    const pending = pendingIds.includes(device.id);
    const label = `Detach ${device.title}`;
    return (
      <button
        aria-label={label}
        className={className}
        disabled={pending}
        onClick={() => setDetachTarget(device)}
        title={label}
        type="button"
      >
        {pending ? (
          <RefreshCw className="spin" size={14} />
        ) : (
          <Unplug size={14} />
        )}
      </button>
    );
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src={thingwebLogo} alt="Thingweb Logo" height={50} />
          <span className="brand-copy">
            <span className="brand-name">
              Thing<em>web</em>
            </span>
            <small>Device Dashboard</small>
          </span>
        </div>

        <nav className="device-nav" aria-label="Overview">
          <p className="nav-label">Overview</p>
          <button
            className={
              view === "dashboard" ? "device-link active" : "device-link"
            }
            onClick={() => setView("dashboard")}
            type="button"
          >
            <LayoutDashboard size={18} />
            <span>
              <strong>Dashboard</strong>
              <small>Fleet summary</small>
            </span>
            <span className="online-dot" aria-label="Available" />
          </button>
        </nav>

        <nav className="device-nav" aria-label="Devices">
          <p className="nav-label">
            Devices{" "}
            <span>
              {connectedDevices.length}/{devices.length}
            </span>
          </p>
          {connectedDevices.map((device) => {
            const Icon = deviceIcon(device);
            const classes = ["device-link"];
            if (device.id === selectedId && view === "device") {
              classes.push("active");
            }
            return (
              <div className="device-row" key={device.id}>
                <button
                  className={classes.join(" ")}
                  onClick={() => {
                    setSelectedId(device.id);
                    setView("device");
                  }}
                  type="button"
                >
                  <Icon size={18} />
                  <span>
                    <strong>{device.title}</strong>
                    <small>{device.metrics.length} signals</small>
                  </span>
                </button>
                {renderDetachButton(device, "connection-toggle")}
              </div>
            );
          })}
        </nav>

        <section className="onboard-nav" aria-label="Onboard a device">
          <p className="nav-label">Onboard a device</p>
          {renderOnboardZone("sidebar", "Drop a Thing Description")}
        </section>

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

        {view === "dashboard" && (
          <>
            <section className="overview-grid single">
              <div className="device-heading">
                <div className="device-kicker">
                  <span>Fleet overview</span>
                  <strong>
                    {connectedDevices.length} of {devices.length} connected
                  </strong>
                </div>
                <h2>Dashboard</h2>
                <p>
                  Live snapshot of every connected thing with averaged readings
                  for common measurements.
                </p>
                <div className="device-meta">
                  <span>
                    <Radio size={15} /> {connectedDevices.length} streaming
                  </span>
                  <span>
                    <RefreshCw size={15} /> Refreshed every 10s
                  </span>
                </div>
              </div>
            </section>

            <section className="metrics-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Monitoring</p>
                  <h2>Alerts</h2>
                </div>
                <span>
                  {alerts.length
                    ? `${alerts.length} active`
                    : "Nothing to report"}
                </span>
              </div>
              {alerts.length ? (
                <div className="alert-grid">
                  {alerts.map((alert) => (
                    <article className="alert-card" key={alert.id} role="alert">
                      <span className="alert-icon">
                        <AlertTriangle size={20} />
                      </span>
                      <div className="alert-copy">
                        <strong>{alert.title}</strong>
                        <span>{alert.device}</span>
                        <small>{relativeTime(alert.timestamp)}</small>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="alert-healthy">
                  <span className="checkmark">✓</span>
                  <div>
                    <strong>All systems healthy</strong>
                    <small>
                      No leakage detected across {connectedDevices.length}{" "}
                      device
                      {connectedDevices.length === 1 ? "" : "s"}
                    </small>
                  </div>
                </div>
              )}
            </section>

            <section className="summary-grid">
              <article className="summary-card">
                <span>Devices</span>
                <strong>{connectedDevices.length}</strong>
                <small>
                  {detachedCount
                    ? `${detachedCount} removed`
                    : "All things connected"}
                </small>
              </article>
              <article className="summary-card">
                <span>Signals</span>
                <strong>{signalCount}</strong>
                <small>Properties and events</small>
              </article>
              <article className="summary-card">
                <span>Live readings</span>
                <strong>{readingCount}</strong>
                <small>Values received</small>
              </article>
              <article className="summary-card">
                <span>Data source</span>
                <strong>{health?.dataSource || "—"}</strong>
                <small>InfluxDB {health?.influx || "—"}</small>
              </article>
            </section>

            <section className="metrics-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Fleet aggregates</p>
                  <h2>Average values</h2>
                </div>
                <span>{averages.length} measurements</span>
              </div>
              <div className="metric-grid">
                {averages.length ? (
                  averages.map((average) => {
                    const Icon = average.icon;
                    return (
                      <article className="metric-card" key={average.key}>
                        <div className="metric-top">
                          <span>{average.label}</span>
                          <Icon size={17} />
                        </div>
                        <strong>
                          {formatValue(average.average, average.unit)}
                        </strong>
                        <small>
                          {average.deviceCount} device
                          {average.deviceCount === 1 ? "" : "s"} ·{" "}
                          {average.signalCount} signal
                          {average.signalCount === 1 ? "" : "s"}
                        </small>
                      </article>
                    );
                  })
                ) : (
                  <p className="chart-empty">No numeric readings yet</p>
                )}
              </div>
            </section>

            <section className="metrics-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Connected things</p>
                  <h2>All devices</h2>
                </div>
                <span>
                  {connectedDevices.length} attached ·{" "}
                  {detachedCount
                    ? `${detachedCount} removed`
                    : "nothing removed"}
                </span>
              </div>
              <div className="device-card-grid">
                {connectedDevices.map((device) => {
                  const Icon = deviceIcon(device);
                  const readings = device.metrics
                    .filter(
                      (metric) =>
                        device.latest[metric.name]?.value !== undefined,
                    )
                    .slice(0, 4);
                  return (
                    <article className="device-card" key={device.id}>
                      <div className="device-card-top">
                        <span className="device-card-icon">
                          <Icon size={18} />
                        </span>
                        <button
                          className="device-card-title"
                          onClick={() => {
                            setSelectedId(device.id);
                            setView("device");
                          }}
                          type="button"
                        >
                          <strong>{device.title}</strong>
                          <small>
                            {device.metrics.length} signals ·{" "}
                            {relativeTime(lastSeen(device))}
                          </small>
                        </button>
                        {renderDetachButton(device, "connection-toggle light")}
                      </div>
                      <ul className="device-card-readings">
                        {readings.map((metric) => (
                          <li key={metric.name}>
                            <span>{metric.title}</span>
                            <strong>
                              {formatValue(
                                device.latest[metric.name]?.value,
                                metric.unit,
                              )}
                            </strong>
                          </li>
                        ))}
                      </ul>
                    </article>
                  );
                })}
                {renderOnboardZone("dashboard", "Drop a Thing Description")}
              </div>
            </section>
          </>
        )}

        {view === "device" && (
          <>
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
                    <RefreshCw size={15} /> Updated{" "}
                    {relativeTime(latestTimestamp)}
                  </span>
                  {selectedDevice && (
                    <button
                      className="connection-button detached"
                      disabled={pendingIds.includes(selectedDevice.id)}
                      onClick={() => setDetachTarget(selectedDevice)}
                      type="button"
                    >
                      <Unplug size={14} />
                      Detach device
                    </button>
                  )}
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
                      className={
                        warning ? "metric-card warning" : "metric-card"
                      }
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
          </>
        )}
      </main>

      {detachTarget && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="detach-title"
        >
          <div className="modal-card">
            <span className="modal-icon">
              <AlertTriangle size={22} />
            </span>
            <h3 id="detach-title">Detach {detachTarget.title}?</h3>
            <p>
              The device is removed from the platform and its telemetry stops
              immediately. To bring it back you must drop the file{" "}
              <code>{detachTarget.title}.td.json</code> onto the onboard zone on
              the dashboard.
            </p>
            <div className="modal-actions">
              <button
                className="modal-button"
                onClick={() => setDetachTarget(undefined)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="modal-button danger"
                onClick={() => void confirmDetach()}
                type="button"
              >
                <Unplug size={14} />
                Detach device
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
