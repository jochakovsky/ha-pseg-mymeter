import { loadCookies, cookieHeader, login } from "./auth";
import type {
  PsegSessionCookies,
  ChartDataResponse,
  DownloadParams,
} from "./types";
import { INTERVAL_MAP, SERVICE_TYPE_MAP, FORMAT_MAP } from "./types";
const BASE_URL = "https://mysmartenergy.nj.pseg.com";

export class PsegClient {
  private session: PsegSessionCookies;

  constructor(session: PsegSessionCookies) {
    this.session = session;
  }

  static async create(): Promise<PsegClient> {
    let session = await loadCookies();
    if (!session) {
      console.log("No saved session found. Starting login...");
      session = await login();
    }
    return new PsegClient(session);
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${BASE_URL}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        cookie: cookieHeader(this.session),
        "x-requested-with": "XMLHttpRequest",
        accept: "text/plain, */*; q=0.01",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        ...init?.headers,
      },
      redirect: "manual",
    });

    // If redirected to login, session expired
    if (res.status === 302 || res.status === 301) {
      const location = res.headers.get("location") ?? "";
      if (location.includes("Home") || location === "/") {
        throw new Error("Session expired. Run `bun src/auth.ts` to re-login.");
      }
    }

    return res;
  }

  /** Extract CSRF token from an HTML response */
  private extractCsrfToken(html: string): string {
    const match = html.match(
      /name="__RequestVerificationToken".*?value="([^"]+)"/
    );
    if (!match) throw new Error("Could not find CSRF token");
    return match[1];
  }

  /** Load /Dashboard as a full page to establish server-side session state.
   *  Also extracts and caches the form CSRF token. */
  private csrfTokenCache: string | null = null;
  private async warmSession(): Promise<string> {
    if (this.csrfTokenCache) return this.csrfTokenCache;

    const res = await fetch(`${BASE_URL}/Dashboard`, {
      headers: {
        cookie: cookieHeader(this.session),
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      redirect: "follow",
    });
    const html = await res.text();
    const token = this.extractCsrfToken(html);
    this.csrfTokenCache = token;
    return token;
  }

  /** Get chart data (JSON) for the current chart settings */
  async getChartData(): Promise<ChartDataResponse> {
    const res = await this.fetch(
      `/Dashboard/ChartData?_=${Date.now()}`
    );
    return res.json();
  }

  /** Change chart interval/date range, then fetch updated chart data */
  async getChartDataForRange(params: {
    interval: DownloadParams["interval"];
    start: string;
    end: string;
  }): Promise<ChartDataResponse> {
    // First, get the chart HTML to extract CSRF token and meter IDs
    const chartRes = await this.fetch(`/Dashboard/Chart?_=${Date.now()}`);
    const chartJson = (await chartRes.json()) as {
      AjaxResults: Array<{ Value: string }>;
    };
    const chartHtml = chartJson.AjaxResults[0]?.Value ?? "";
    const csrfToken = this.extractCsrfToken(chartHtml);

    // Extract meter IDs from the HTML
    const meterMatch = chartHtml.match(/value='(\[.*?\])'/);
    const meterIds = meterMatch ? meterMatch[1] : "";

    // POST to change chart settings
    const body = new URLSearchParams({
      __RequestVerificationToken: csrfToken,
      UsageInterval: INTERVAL_MAP[params.interval],
      UsageType: "1",
      jsTargetName: "StorageType",
      EnableHoverChart: "true",
      Start: params.start,
      End: params.end,
      IsRangeOpen: "False",
      MaintainMaxDate: "true",
      SelectedViaDateRange: "False",
      ChartComparison: "0",
      ChartComparison2: "0",
      ChartComparison3: "0",
      ChartComparison4: "0",
    });
    body.append("meterIds", meterIds);
    body.append("meterIds", "-1");

    await this.fetch("/Dashboard/Chart/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    // Now fetch the updated chart data
    return this.getChartData();
  }

  /** Download usage data as CSV */
  async downloadCsv(params: DownloadParams): Promise<string> {
    // Get CSRF token from Dashboard page load
    const csrfToken = await this.warmSession();

    const body = new URLSearchParams({
      HasMultipleUsageTypes: "False",
      FileFormat: "download-usage-csv",
      SelectedFormat: FORMAT_MAP[params.format],
      ThirdPartyPODID: "",
      SelectedServiceType: SERVICE_TYPE_MAP[params.serviceType],
      "Meters[0].Value": "1361117",
      "Meters[0].Selected": "true",
      SelectedInterval: INTERVAL_MAP[params.interval],
      SelectedUsageType: SERVICE_TYPE_MAP[params.serviceType],
      Start: params.start,
      End: params.end,
      // Include ReadDate and Consumption columns
      "ColumnOptions[0].Value": "ReadDate",
      "ColumnOptions[0].Name": "ReadDate",
      "ColumnOptions[0].Checked": "true",
      "ColumnOptions[1].Value": "AccountNumber",
      "ColumnOptions[1].Name": "AccountNumber",
      "ColumnOptions[1].Checked": "false",
      "ColumnOptions[2].Value": "Name",
      "ColumnOptions[2].Name": "Name",
      "ColumnOptions[2].Checked": "false",
      "ColumnOptions[3].Value": "Meter",
      "ColumnOptions[3].Name": "Meter",
      "ColumnOptions[3].Checked": "false",
      "ColumnOptions[4].Value": "Location",
      "ColumnOptions[4].Name": "Location",
      "ColumnOptions[4].Checked": "false",
      "ColumnOptions[5].Value": "Address",
      "ColumnOptions[5].Name": "Address",
      "ColumnOptions[5].Checked": "false",
      "ColumnOptions[6].Value": "Consumption",
      "ColumnOptions[6].Name": "Consumption",
      "ColumnOptions[6].Checked": "true",
      "RowOptions[0].Value": "ReadDate",
      "RowOptions[0].Name": "Read Date",
      "RowOptions[0].Desc": "false",
      "RowOptions[1].Value": "Consumption",
      "RowOptions[1].Name": "kWh",
      "RowOptions[1].Desc": "false",
      __RequestVerificationToken: csrfToken,
    });

    // Validate first
    const validateRes = await this.fetch("/Usage/PresentDownloadErrors", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const validation = await validateRes.json();
    if (validation.Data) {
      throw new Error(`Download validation error: ${JSON.stringify(validation.Data)}`);
    }

    // Download CSV
    const downloadRes = await this.fetch("/Usage/Download", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/csv, */*",
      },
      body: body.toString(),
    });

    if (!downloadRes.ok) {
      throw new Error(`Download failed: ${downloadRes.status}`);
    }

    return downloadRes.text();
  }
}

if (import.meta.main) {
  const client = await PsegClient.create();

  // Fetch latest chart data
  console.log("Fetching chart data...");
  const chartData = await client.getChartData();
  const series = chartData.Data?.series?.[1];
  if (series) {
    console.log(`\nSeries: ${series.name}`);
    console.log(`Points: ${series.data.length}`);
    const last = series.data[series.data.length - 1];
    if (last && typeof last === "object" && "x" in last) {
      console.log(
        `Latest: ${new Date(last.x).toLocaleDateString()} = ${last.y} kWh`
      );
    }
  }

  // Download recent CSV
  console.log("\nDownloading CSV (last 7 days, 15-min intervals)...");
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const csv = await client.downloadCsv({
    format: "csv",
    serviceType: "electric",
    interval: "15min",
    start: weekAgo.toISOString().split("T")[0],
    end: now.toISOString().split("T")[0],
  });
  console.log(`\nCSV preview (first 500 chars):\n${csv.slice(0, 500)}`);
}
