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
}

export default function TrendChart({ colors, data, metrics }: TrendChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={data}
        margin={{ top: 14, right: 8, left: -16, bottom: 0 }}
      >
        <CartesianGrid
          stroke="#e4e8e5"
          strokeDasharray="3 5"
          vertical={false}
        />
        <XAxis
          dataKey="timestamp"
          tickFormatter={(value) =>
            new Date(value).toLocaleDateString([], {
              month: "short",
              day: "numeric",
            })
          }
          minTickGap={34}
          stroke="#8b938e"
          tickLine={false}
          axisLine={false}
          fontSize={11}
        />
        <YAxis
          stroke="#8b938e"
          tickLine={false}
          axisLine={false}
          fontSize={11}
        />
        <Tooltip
          labelFormatter={(value) => new Date(Number(value)).toLocaleString()}
          contentStyle={{
            borderRadius: 6,
            border: "1px solid #dce1dd",
            boxShadow: "0 8px 24px rgba(31, 38, 34, .08)",
          }}
        />
        <Legend iconType="circle" iconSize={7} />
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
