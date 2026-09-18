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
  Flame,
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
  getThingDescription,
  setDeviceConnection,
  type DeviceDefinition,
  type HealthStatus,
  type MetricDefinition,
  type TelemetryPoint,
  type TelemetryValue,
  type ThingDescriptionVariant,
} from "./api";
import { useDeviceStream } from "./useDeviceStream";
import "./App.css";
import thingwebLogo from "../public/thingweb-logo.png";

type RangeKey = "15m" | "1h" | "24h" | "7d" | "30d";
type PhaseGroup = "voltage" | "current" | "power";
type View = "dashboard" | "device";

const TrendChart = lazy(() => import("./TrendChart"));
const EMPTY_LATEST: Record<string, TelemetryPoint> = {};
const EMPTY_HISTORY: Record<string, TelemetryPoint[]> = {};
const CHART_COLORS = ["#33b8a4", "#d65cab", "#e09f3e", "#5fd3c1"];
const RANGE_OPTIONS: { key: RangeKey; label: string; minutes: number }[] = [
  { key: "15m", label: "15M", minutes: 15 },
  { key: "1h", label: "1H", minutes: 60 },
  { key: "24h", label: "24H", minutes: 24 * 60 },
  { key: "7d", label: "7D", minutes: 7 * 24 * 60 },
  { key: "30d", label: "30D", minutes: 30 * 24 * 60 },
];
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

function buildChartData(
  series: Record<string, TelemetryPoint[]>,
  metrics: string[],
  rangeMinutes: number,
) {
  const cutoff = Date.now() - rangeMinutes * 60 * 1000;
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

// Signals worth plotting first when a device exposes more series than a chart can show.
const TREND_PRIORITY = [
  "temperature",
  "humidity",
  "power",
  "current",
  "voltage",
  "battery",
];

function trendMetricsOf(device: DeviceDefinition) {
  const rank = (name: string) => {
    const index = TREND_PRIORITY.findIndex((key) =>
      name.toLowerCase().includes(key),
    );
    return index === -1 ? TREND_PRIORITY.length : index;
  };
  return device.metrics
    .filter((metric) => ["number", "integer"].includes(metric.value_type))
    .slice()
    .sort((left, right) => rank(left.name) - rank(right.name))
    .map((metric) => metric.name);
}

interface DeviceTrendPanelProps {
  device: DeviceDefinition;
  metricKey: string;
  rangeMinutes: number;
  timeAxis: boolean;
  onOpen: (deviceId: string) => void;
}

function DeviceTrendPanel({
  device,
  metricKey,
  rangeMinutes,
  timeAxis,
  onOpen,
}: DeviceTrendPanelProps) {
  const [series, setSeries] =
    useState<Record<string, TelemetryPoint[]>>(EMPTY_HISTORY);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const deviceId = device.id;

  useEffect(() => {
    const metrics = metricKey ? metricKey.split(",") : [];
    if (metrics.length === 0) {
      setSeries(EMPTY_HISTORY);
      setStatus("ready");
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    getDeviceHistory(deviceId, metrics, rangeMinutes, controller.signal)
      .then((response) => {
        setSeries(response.series);
        setStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("error");
      });
    return () => controller.abort();
  }, [deviceId, metricKey, rangeMinutes]);

  // Only series the history backend actually returned are charted.
  const chartMetrics = useMemo(
    () =>
      (metricKey ? metricKey.split(",") : [])
        .filter((metric) => (series[metric]?.length ?? 0) > 1)
        .slice(0, 3),
    [metricKey, series],
  );
  const data = useMemo(
    () => buildChartData(series, chartMetrics, rangeMinutes),
    [chartMetrics, rangeMinutes, series],
  );
  const titles = new Map(
    device.metrics.map((metric) => [metric.name, metric.title]),
  );
  const Icon = deviceIcon(device);

  return (
    <article className="chart-panel">
      <div className="section-heading chart-heading">
        <div>
          <p className="eyebrow">
            <Icon size={12} /> {device.title}
          </p>
          <h2>{chartMetrics.length ? "Recent trend" : "No trend data"}</h2>
        </div>
        <button
          className="trend-open"
          onClick={() => onOpen(deviceId)}
          type="button"
        >
          Open device
        </button>
      </div>
      <div className="chart-wrap compact">
        {status === "loading" ? (
          <div className="chart-empty">
            <RefreshCw className="spin" size={22} /> Loading history
          </div>
        ) : status === "error" ? (
          <div className="chart-empty">History unavailable</div>
        ) : data.length ? (
          <Suspense
            fallback={
              <div className="chart-empty">
                <RefreshCw className="spin" size={22} /> Loading chart
              </div>
            }
          >
            <TrendChart
              colors={CHART_COLORS}
              data={data}
              timeAxis={timeAxis}
              metrics={chartMetrics.map((metric) => ({
                key: metric,
                label: titles.get(metric) || metric,
              }))}
            />
          </Suspense>
        ) : (
          <div className="chart-empty">No stored history in this range</div>
        )}
      </div>
    </article>
  );
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

// Alarm affordances are recognised by their TD annotation, e.g. "brick:Leak_Alarm".
const ALARM_TYPE_PATTERN = /_alarm$/i;
const INACTIVE_ALARM_VALUES = new Set([
  "normal",
  "ok",
  "off",
  "false",
  "no",
  "none",
  "clear",
  "inactive",
  "0",
]);

interface AlarmSignal {
  id: string;
  deviceId: string;
  deviceTitle: string;
  metric: MetricDefinition;
  label: string;
  subject: string;
  icon: LucideIcon;
  fallback?: TelemetryPoint;
}

function alarmTypeOf(metric: MetricDefinition) {
  const type = metric.semantic_type?.split(":").pop();
  return type && ALARM_TYPE_PATTERN.test(type) ? type : undefined;
}

function alarmIcon(type: string): LucideIcon {
  const name = type.toLowerCase();
  if (name.includes("leak") || name.includes("water") || name.includes("flood"))
    return Droplets;
  if (name.includes("smoke") || name.includes("fire")) return Flame;
  if (name.includes("temperature") || name.includes("frost"))
    return Thermometer;
  if (name.includes("humidity")) return Droplets;
  if (name.includes("battery")) return BatteryMedium;
  if (
    name.includes("voltage") ||
    name.includes("current") ||
    name.includes("power")
  )
    return Zap;
  return AlertTriangle;
}

function isAlarmActive(value: TelemetryValue | undefined) {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return !INACTIVE_ALARM_VALUES.has(value.trim().toLowerCase());
}

function collectAlarmSignals(devices: DeviceDefinition[]): AlarmSignal[] {
  return devices.flatMap((device) =>
    device.metrics.flatMap((metric) => {
      const type = alarmTypeOf(metric);
      if (!type) return [];
      const subject = type.replace(ALARM_TYPE_PATTERN, "").replace(/_/g, " ");
      return [
        {
          id: `${device.id}:${metric.name}`,
          deviceId: device.id,
          deviceTitle: device.title,
          metric,
          label: type.replace(/_/g, " "),
          subject: subject || "Alarm",
          icon: alarmIcon(type),
          fallback: device.latest[metric.name],
        },
      ];
    }),
  );
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
  const [rangeKey, setRangeKey] = useState<RangeKey>("7d");
  const [fleetRangeKey, setFleetRangeKey] = useState<RangeKey>("24h");
  const [phaseGroup, setPhaseGroup] = useState<PhaseGroup>("voltage");
  const [view, setView] = useState<View>("dashboard");
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [detachTarget, setDetachTarget] = useState<DeviceDefinition>();
  const [tdTarget, setTdTarget] = useState<DeviceDefinition>();
  const [tdVariant, setTdVariant] = useState<ThingDescriptionVariant>("zenoh");
  const [tdDocument, setTdDocument] = useState<string>();
  const [tdError, setTdError] = useState<string>();
  const [dropZone, setDropZone] = useState<string>();
  const [onboardError, setOnboardError] = useState<string>();
  const eventRef = useRef<HTMLUiEventElement>(null);
  const lastAlarmEvent = useRef<string | undefined>(undefined);

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

  const tdTargetId = tdTarget?.id;
  useEffect(() => {
    if (!tdTargetId) return;
    const controller = new AbortController();
    setTdDocument(undefined);
    setTdError(undefined);
    getThingDescription(tdTargetId, tdVariant, controller.signal)
      .then((document) => setTdDocument(JSON.stringify(document, null, 2)))
      .catch(() => {
        if (controller.signal.aborted) return;
        setTdError(
          tdVariant === "original"
            ? "No original Thing Description is stored for this device."
            : "Unable to load the Thing Description.",
        );
      });
    return () => controller.abort();
  }, [tdTargetId, tdVariant]);

  const selectedDevice = devices.find(
    (device) => device.id === selectedId && device.connected,
  );
  const selectedInitial = selectedDevice?.latest || EMPTY_LATEST;
  const selectedStream = useDeviceStream(selectedDevice?.id, selectedInitial);
  const connectedDevices = useMemo(
    () => devices.filter((device) => device.connected),
    [devices],
  );
  const alarmSignals = useMemo(
    () => collectAlarmSignals(connectedDevices),
    [connectedDevices],
  );
  // Only one extra socket is opened; alarms on further devices use polled values.
  const backgroundAlarmDeviceId = alarmSignals.find(
    (signal) => signal.deviceId !== selectedDevice?.id,
  )?.deviceId;
  const backgroundDevice = connectedDevices.find(
    (device) => device.id === backgroundAlarmDeviceId,
  );
  const backgroundStream = useDeviceStream(
    backgroundAlarmDeviceId,
    backgroundDevice?.latest || EMPTY_LATEST,
  );
  const alarmPointOf = useCallback(
    (signal: AlarmSignal) => {
      if (signal.deviceId === selectedDevice?.id) {
        return selectedStream.latest[signal.metric.name] ?? signal.fallback;
      }
      if (signal.deviceId === backgroundAlarmDeviceId) {
        return backgroundStream.latest[signal.metric.name] ?? signal.fallback;
      }
      return signal.fallback;
    },
    [
      backgroundAlarmDeviceId,
      backgroundStream.latest,
      selectedDevice?.id,
      selectedStream.latest,
    ],
  );
  const selectedAlarms = useMemo(
    () =>
      alarmSignals.filter((signal) => signal.deviceId === selectedDevice?.id),
    [alarmSignals, selectedDevice?.id],
  );
  const primaryAlarm = selectedAlarms[0] ?? alarmSignals[0];
  const primaryAlarmPoint = primaryAlarm
    ? alarmPointOf(primaryAlarm)
    : undefined;
  const primaryAlarmStatus =
    primaryAlarm?.deviceId === backgroundAlarmDeviceId
      ? backgroundStream.status
      : selectedStream.status;
  const isSentron = selectedDevice?.metrics.some(
    (metric) => metric.name === "current-l1",
  );

  const historyMetrics = useMemo(() => {
    if (!selectedDevice) return [];
    if (isSentron) return Object.values(PHASE_GROUPS).flat();
    return trendMetricsOf(selectedDevice);
  }, [isSentron, selectedDevice]);
  const rangeMinutes =
    RANGE_OPTIONS.find((option) => option.key === rangeKey)?.minutes ??
    7 * 24 * 60;

  useEffect(() => {
    if (!selectedDevice || historyMetrics.length === 0) {
      return;
    }
    const controller = new AbortController();
    getDeviceHistory(
      selectedDevice.id,
      historyMetrics,
      rangeMinutes,
      controller.signal,
    )
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
  }, [historyMetrics, rangeMinutes, selectedDevice]);

  useEffect(() => {
    const eventElement = eventRef.current;
    if (!eventElement) return;
    void eventElement.startListening();
    void eventElement.setStatus(
      primaryAlarmStatus === "live"
        ? "success"
        : primaryAlarmStatus === "connecting"
          ? "loading"
          : "error",
      primaryAlarmStatus === "offline" ? "Alarm stream unavailable" : undefined,
    );
    if (
      primaryAlarmPoint?.timestamp &&
      lastAlarmEvent.current !== primaryAlarmPoint.timestamp
    ) {
      lastAlarmEvent.current = primaryAlarmPoint.timestamp;
      void eventElement.addEvent(
        { state: primaryAlarmPoint.value, device: primaryAlarm?.deviceTitle },
        primaryAlarmPoint.timestamp,
      );
    }
  }, [primaryAlarm?.deviceTitle, primaryAlarmPoint, primaryAlarmStatus]);

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

  const history =
    historyState.deviceId === selectedDevice?.id
      ? historyState.series
      : EMPTY_HISTORY;
  const chartMetrics = isSentron
    ? PHASE_GROUPS[phaseGroup]
    : historyMetrics
        .filter((metric) => (history[metric]?.length ?? 0) > 1)
        .slice(0, 3);
  const historyLoading = Boolean(
    selectedDevice &&
    historyMetrics.length &&
    historyState.deviceId !== selectedDevice.id,
  );
  const chartData = useMemo(
    () => buildChartData(history, chartMetrics, rangeMinutes),
    [chartMetrics, history, rangeMinutes],
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
  const fleetRangeMinutes =
    RANGE_OPTIONS.find((option) => option.key === fleetRangeKey)?.minutes ??
    24 * 60;
  // Joining the names keeps the per-panel fetch stable across device polls.
  const trendPanels = useMemo(
    () =>
      connectedDevices.map((device) => ({
        device,
        metricKey: trendMetricsOf(device).join(","),
      })),
    [connectedDevices],
  );
  const signalCount = connectedDevices.reduce(
    (total, device) => total + device.metrics.length,
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

  const alerts = useMemo(
    () =>
      alarmSignals
        .map((signal) => ({ signal, point: alarmPointOf(signal) }))
        .filter(({ point }) => isAlarmActive(point?.value))
        .map(({ signal, point }) => ({
          id: signal.id,
          title: `${signal.subject} detected`,
          device: signal.deviceTitle,
          icon: signal.icon,
          timestamp: point?.timestamp,
        })),
    [alarmPointOf, alarmSignals],
  );

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
        onClick={(event) => {
          event.stopPropagation();
          setDetachTarget(device);
        }}
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
            Devices <span>{connectedDevices.length}</span>
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
            <span>History</span>
            <strong>{health?.historySource || "—"}</strong>
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
                <h2>Dashboard</h2>
                <p style={{ marginBottom: 0 }}>
                  Live snapshot of every connected thing with averaged readings
                  for common measurements
                </p>
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
                  {alerts.map((alert) => {
                    const Icon = alert.icon;
                    return (
                      <article
                        className="alert-card"
                        key={alert.id}
                        role="alert"
                      >
                        <span className="alert-icon">
                          <Icon size={20} />
                        </span>
                        <div className="alert-copy">
                          <strong>{alert.title}</strong>
                          <span>{alert.device}</span>
                          <small>{relativeTime(alert.timestamp)}</small>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="alert-grid">
                  <div className="alert-healthy">
                    <span className="checkmark">✓</span>
                    <div>
                      <strong>All systems healthy</strong>
                      <small>
                        No active alarms across {connectedDevices.length} device
                        {connectedDevices.length === 1 ? "" : "s"}
                      </small>
                    </div>
                  </div>
                </div>
              )}
            </section>

            <section className="summary-grid">
              <article className="summary-card">
                <span>Devices</span>
                <strong>{connectedDevices.length}</strong>
                <small>Things onboarded from a TD</small>
              </article>
              <article className="summary-card">
                <span>Signals</span>
                <strong>{signalCount}</strong>
                <small>Properties and events exposed</small>
              </article>
              <article className="summary-card">
                <span>Poll interval</span>
                <strong>
                  {health ? `${health.pollIntervalSeconds}s` : "—"}
                </strong>
                <small>Telemetry refresh cadence</small>
              </article>
              <article className="summary-card">
                <span>Data source</span>
                <strong>{health?.dataSource || "—"}</strong>
                <small>Live readings</small>
              </article>
              <article className="summary-card">
                <span>History source</span>
                <strong>{health?.historySource || "—"}</strong>
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
                  <p className="eyebrow">Historical telemetry</p>
                  <h2>Trends</h2>
                </div>
                <div className="range-control" aria-label="Trend range">
                  {RANGE_OPTIONS.map((option) => (
                    <button
                      key={option.key}
                      className={fleetRangeKey === option.key ? "active" : ""}
                      type="button"
                      onClick={() => setFleetRangeKey(option.key)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="trend-grid">
                {trendPanels.length ? (
                  trendPanels.map(({ device, metricKey }) => (
                    <DeviceTrendPanel
                      device={device}
                      key={device.id}
                      metricKey={metricKey}
                      onOpen={(deviceId) => {
                        setSelectedId(deviceId);
                        setView("device");
                      }}
                      rangeMinutes={fleetRangeMinutes}
                      timeAxis={fleetRangeMinutes <= 24 * 60}
                    />
                  ))
                ) : (
                  <p className="chart-empty">No device is onboarded</p>
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
                    <article
                      className="device-card"
                      key={device.id}
                      onClick={() => {
                        setSelectedId(device.id);
                        setView("device");
                      }}
                    >
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
            <section
              className={
                selectedAlarms.length ? "overview-grid" : "overview-grid single"
              }
            >
              <div className="device-heading">
                <div className="device-kicker">
                  <span>Selected device</span>
                </div>
                <h2>{selectedDevice?.title || "Loading devices"}</h2>
                <p>
                  {selectedDevice?.description ||
                    "Connecting to telemetry service…"}
                </p>
                <div className="device-meta">
                  {selectedDevice && (
                    <>
                      <button
                        className="connection-button"
                        onClick={() => {
                          setTdVariant("zenoh");
                          setTdTarget(selectedDevice);
                        }}
                        type="button"
                      >
                        <FileJson size={14} />
                        Thing Description
                      </button>
                      <button
                        className="connection-button detached"
                        disabled={pendingIds.includes(selectedDevice.id)}
                        onClick={() => setDetachTarget(selectedDevice)}
                        type="button"
                      >
                        <Unplug size={14} />
                        Detach device
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="alarm-panels">
                {selectedAlarms.map((signal) => {
                  const point = alarmPointOf(signal);
                  const active = isAlarmActive(point?.value);
                  const Icon = signal.icon;
                  return (
                    <div
                      className={
                        active ? "alarm-panel alerting" : "alarm-panel"
                      }
                      key={signal.id}
                    >
                      <div className="alarm-icon">
                        <Icon size={24} />
                      </div>
                      <div className="alarm-copy">
                        <span>{signal.label}</span>
                        <strong>
                          {active
                            ? `${signal.subject} detected`
                            : `No ${signal.subject.toLowerCase()}`}
                        </strong>
                        <small>{relativeTime(point?.timestamp)}</small>
                      </div>
                      <div
                        className="alarm-state"
                        aria-label={active ? "Warning" : "Normal"}
                      >
                        {active ? (
                          <AlertTriangle size={18} />
                        ) : (
                          <span className="checkmark">✓</span>
                        )}
                      </div>
                    </div>
                  );
                })}
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
                  const warning = Boolean(
                    alarmTypeOf(metric) && isAlarmActive(point?.value),
                  );
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
                    {RANGE_OPTIONS.map((option) => (
                      <button
                        key={option.key}
                        className={rangeKey === option.key ? "active" : ""}
                        type="button"
                        onClick={() => setRangeKey(option.key)}
                      >
                        {option.label}
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
                        timeAxis={rangeMinutes <= 24 * 60}
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
            </section>
          </>
        )}
      </main>

      {tdTarget && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="td-title"
        >
          <div className="modal-card wide">
            <h3 id="td-title">{tdTarget.title}</h3>
            <p>
              {tdVariant === "zenoh"
                ? "Zenoh Thing Description consumed by the dashboard."
                : "Original vendor Thing Description this proxy was derived from."}
            </p>
            <div className="td-switch">
              <button
                className={tdVariant === "zenoh" ? "td-tab active" : "td-tab"}
                onClick={() => setTdVariant("zenoh")}
                type="button"
              >
                Zenoh TD
              </button>
              <button
                className={
                  tdVariant === "original" ? "td-tab active" : "td-tab"
                }
                onClick={() => setTdVariant("original")}
                type="button"
              >
                Original TD
              </button>
            </div>
            <div className="td-viewer">
              {tdError ? (
                <p className="td-error">{tdError}</p>
              ) : tdDocument ? (
                <pre>{tdDocument}</pre>
              ) : (
                <p className="td-loading">
                  <RefreshCw className="spin" size={16} /> Loading
                </p>
              )}
            </div>
            <div className="modal-actions">
              <button
                className="modal-button"
                onClick={() => setTdTarget(undefined)}
                type="button"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

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
