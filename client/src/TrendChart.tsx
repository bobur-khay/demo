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

interface TrendChartProps {
  colors: string[];
  data: Record<string, number | string>[];
  metrics: Array<{ key: string; label: string }>;
  timeAxis?: boolean;
}

export default function TrendChart({
  colors,
  data,
  metrics,
  timeAxis = false,
}: TrendChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={data}
        margin={{ top: 14, right: 8, left: -16, bottom: 0 }}
      >
        <CartesianGrid
          stroke="#2e2f2f"
          strokeDasharray="3 5"
          vertical={false}
        />
        <XAxis
          dataKey="timestamp"
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
          minTickGap={34}
          stroke="#7e807f"
          tickLine={false}
          axisLine={false}
          fontFamily="Fira Mono, monospace"
          fontSize={11}
        />
        <YAxis
          stroke="#7e807f"
          tickLine={false}
          axisLine={false}
          fontFamily="Fira Mono, monospace"
          fontSize={11}
        />
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
          <Line
            key={metric.key}
            type="monotone"
            dataKey={metric.key}
            name={metric.label}
            stroke={colors[index]}
            strokeWidth={2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
