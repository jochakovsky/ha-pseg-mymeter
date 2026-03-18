export interface PsegSessionCookies {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  savedAt: string;
}

export interface ChartDataResponse {
  AjaxResults: unknown[];
  Data: {
    colors: string[];
    series: ChartSeries[];
    usageType: string;
    maxUsageDate: number;
    maxUsage: number;
    minUsageDate: number;
    minUsage: number;
    xAxis: { minRange: number; maxRange: number };
    yAxis: Array<{ title: { text: string } }>;
    chartLastMin: number;
    chartLastMax: number;
    useRangeMin: number;
    useRangeMax: number;
    tooltipOptions: {
      storageType: string;
      usageTypeDisplayName: string;
      locale: string;
      currency: string;
      meterCount: number;
      enableHoverChart: boolean;
    };
  };
}

export interface ChartSeries {
  name?: string;
  type: string;
  data: ChartDataPoint[];
  yAxis?: number;
}

export type ChartDataPoint =
  | [number, number] // [timestamp_ms, kWh] for navigator series
  | {
      x: number; // timestamp_ms
      y: number; // kWh
      hs?: { start: string; end: string };
      xs?: number;
      xe?: number;
      v?: boolean;
    };

export interface DownloadParams {
  format: "csv" | "greenbutton";
  serviceType: "electric" | "gas";
  interval: "15min" | "30min" | "hourly" | "daily";
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

export const INTERVAL_MAP: Record<DownloadParams["interval"], string> = {
  "15min": "3",
  "30min": "4",
  "hourly": "5",
  "daily": "6",
};

export const SERVICE_TYPE_MAP: Record<DownloadParams["serviceType"], string> = {
  electric: "1",
  gas: "4",
};

export const FORMAT_MAP: Record<DownloadParams["format"], string> = {
  csv: "2",
  greenbutton: "1",
};
