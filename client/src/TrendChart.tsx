import { Fragment, useMemo } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// A gap must exceed this multiple of the median sampling interval to count.
const GAP_FACTOR = 3;

interface TrendChartProps {
  colors: string[];
  data: Record<string, number | string>[];
  metrics: Array<{ key: string; label: string }>;
  timeAxis?: boolean;
  rangeMinutes?: number;
}

// Assign each metric to left or right Y-axis based on order of magnitude.
// Metrics within 10× of the first metric's max share the left axis.
function assignAxes(
  data: Record<string, number | string>[],
  metrics: Array<{ key: string }>,
): ("left" | "right")[] {
  if (metrics.length === 0) return [];
  const maxVal = (key: string) =>
    data.reduce(
      (acc, row) => Math.max(acc, Math.abs(Number(row[key] ?? 0))),
      0,
    );
  const maxValues = metrics.map((m) => maxVal(m.key));
  const ref = maxValues[0] || 1;
  return maxValues.map((v) =>
    v <= ref * 10 && v >= ref / 10 ? "left" : "right",
  );
}

// Augment the shared chart data array for gap-aware rendering.
//
// For each metric:
// 1. Forward-fill its value to shared timestamps within its active range so
//    timestamp misalignment between metrics doesn't produce false line breaks.
// 2. Detect real gaps (intervals > GAP_FACTOR × median sampling interval).
// 3. For each gap: null out interior rows in the solid-line key so
//    connectNulls=false breaks there; create a unique `{key}_gap_{i}` key
//    with values ONLY at the two boundary rows so that a separate Line with
//    connectNulls=true draws a single straight dashed bridge — no fake
//    intermediate points appear anywhere.
function augmentData(
  data: Record<string, number | string>[],
  metricKeys: string[],
): {
  rows: Record<string, number | string | null>[];
  gapLineKeys: Map<string, string[]>;
} {
  const gapLineKeys = new Map<string, string[]>();
  if (data.length === 0) return { rows: [], gapLineKeys };

  const rows: Record<string, number | string | null>[] = data.map((r) => ({
    ...r,
  }));

  for (const key of metricKeys) {
    const series = rows
      .map((row, idx) => ({ idx, ts: Number(row.timestamp), v: row[key] }))
      .filter(
        (p): p is { idx: number; ts: number; v: number } =>
          typeof p.v === "number",
      );

    if (series.length < 2) continue;

    const intervals = series
      .slice(1)
      .map((p, i) => p.ts - series[i].ts);
    const sortedIntervals = [...intervals].sort((a, b) => a - b);
    const median = sortedIntervals[Math.floor(sortedIntervals.length / 2)];
    const threshold = median * GAP_FACTOR;

    // Forward-fill within the metric's active range so timestamp misalignment
    // with other metrics doesn't cause false line breaks in the solid line.
    {
      const rangeStart = series[0].ts;
      const rangeEnd = series[series.length - 1].ts;
      let lastValue: number | null = null;
      for (let i = 0; i < rows.length; i++) {
        const ts = Number(rows[i].timestamp);
        if (ts < rangeStart || ts > rangeEnd) continue;
        if (typeof rows[i][key] === "number") {
          lastValue = rows[i][key] as number;
        } else if (lastValue !== null) {
          rows[i][key] = lastValue;
        }
      }
    }

    // Detect gaps and create one gap-line key per segment.
    const metricGapKeys: string[] = [];
    for (let i = 0; i < intervals.length; i++) {
      if (intervals[i] <= threshold) continue;

      const s = series[i];
      const e = series[i + 1];

      // One unique key per gap segment: only the two boundary rows get values.
      // connectNulls=true on that Line draws exactly one straight bridge.
      const gapKey = `${key}_gap_${i}`;
      rows[s.idx][gapKey] = s.v;
      rows[e.idx][gapKey] = e.v;

      // Break the solid line through the gap interior.
      // When the gap boundaries are adjacent (no intermediate rows), null the
      // start row so the solid line still breaks — otherwise both a solid and
      // a dotted line would appear between the same two points.
      if (e.idx <= s.idx + 1) {
        rows[s.idx][key] = null;
      } else {
        for (let j = s.idx + 1; j < e.idx; j++) {
          rows[j][key] = null;
        }
      }

      metricGapKeys.push(gapKey);
    }

    if (metricGapKeys.length > 0) {
      gapLineKeys.set(key, metricGapKeys);
    }
  }

  return { rows, gapLineKeys };
}

// Generate evenly-spaced tick timestamps and a [start, end] domain for the
// x-axis so the full selected range is always visible, regardless of how
// sparse the data is.
function buildXAxis(
  rangeMinutes: number,
  timeAxis: boolean,
): { ticks: number[]; domain: [number, number] } {
  const now = Date.now();
  const start = now - rangeMinutes * 60 * 1000;

  // Number of ticks and their alignment depend on the view.
  let ticks: number[];
  if (timeAxis) {
    // 24 h → tick every 4 h, aligned to full hours.
    const step = 4 * 60 * 60 * 1000;
    const first = Math.ceil(start / step) * step;
    ticks = [];
    for (let t = first; t <= now; t += step) ticks.push(t);
  } else if (rangeMinutes <= 7 * 24 * 60) {
    // 7 d → one tick per day at midnight (local time).
    ticks = [];
    const d = new Date(start);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1); // first midnight after start
    while (d.getTime() <= now) {
      ticks.push(d.getTime());
      d.setDate(d.getDate() + 1);
    }
  } else {
    // 30 d → tick every 5 days at midnight.
    ticks = [];
    const d = new Date(start);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    while (d.getTime() <= now) {
      ticks.push(d.getTime());
      d.setDate(d.getDate() + 5);
    }
  }

  return { ticks, domain: [start, now] };
}

export default function TrendChart({
  colors,
  data,
  metrics,
  timeAxis = false,
  rangeMinutes = 24 * 60,
}: TrendChartProps) {
  const axes = useMemo(() => assignAxes(data, metrics), [data, metrics]);
  const hasRightAxis = axes.includes("right");

  const { rows, gapLineKeys } = useMemo(
    () => augmentData(data, metrics.map((m) => m.key)),
    [data, metrics],
  );

  const { ticks, domain } = useMemo(
    () => buildXAxis(rangeMinutes, timeAxis),
    [rangeMinutes, timeAxis],
  );

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={rows as Record<string, unknown>[]}
        margin={{ top: 14, right: hasRightAxis ? 40 : 8, left: -16, bottom: 0 }}
      >
        <CartesianGrid
          stroke="#2e2f2f"
          strokeDasharray="3 5"
          vertical={false}
        />
        <XAxis
          dataKey="timestamp"
          type="number"
          scale="time"
          domain={domain}
          ticks={ticks}
          tickFormatter={(value) =>
            timeAxis
              ? new Date(value).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : new Date(value).toLocaleDateString([], {
                  month: "short",
                  day: "numeric",
                })
          }
          stroke="#7e807f"
          tickLine={false}
          axisLine={false}
          fontFamily="Fira Mono, monospace"
          fontSize={11}
        />
        <YAxis
          yAxisId="left"
          stroke="#7e807f"
          tickLine={false}
          axisLine={false}
          fontFamily="Fira Mono, monospace"
          fontSize={11}
        />
        {hasRightAxis && (
          <YAxis
            yAxisId="right"
            orientation="right"
            stroke="#7e807f"
            tickLine={false}
            axisLine={false}
            fontFamily="Fira Mono, monospace"
            fontSize={11}
          />
        )}
        <Tooltip
          labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
          cursor={{ stroke: "#4c4d4c" }}
          contentStyle={{
            borderRadius: 10,
            border: "1px solid #4c4d4c",
            background: "#1e1e1e",
            color: "#fffffe",
            fontFamily: "Fira Mono, monospace",
            fontSize: 12,
            boxShadow: "0 8px 24px rgba(0, 0, 0, .35)",
          }}
          itemStyle={{ color: "#cacccc" }}
          labelStyle={{ color: "#979999" }}
        />
        <Legend
          iconType="circle"
          iconSize={7}
          wrapperStyle={{
            color: "#cacccc",
            fontFamily: "Fira Mono, monospace",
            fontSize: 12,
          }}
        />
        {metrics.map((metric, index) => (
          <Fragment key={metric.key}>
            <Line
              yAxisId={axes[index]}
              type="monotone"
              dataKey={metric.key}
              name={metric.label}
              stroke={colors[index]}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
            {(gapLineKeys.get(metric.key) ?? []).map((gapKey) => (
              <Line
                key={gapKey}
                yAxisId={axes[index]}
                type="linear"
                dataKey={gapKey}
                name={metric.label}
                stroke={colors[index]}
                strokeWidth={1.5}
                strokeDasharray="5 4"
                strokeOpacity={0.5}
                dot={false}
                connectNulls={true}
                legendType="none"
                isAnimationActive={false}
              />
            ))}
          </Fragment>
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
