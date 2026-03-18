import { PsegClient } from "./client";
import { oktaLogin } from "./okta-auth";
import { loadCookies } from "./auth";
import { appendFile, mkdir } from "fs/promises";
import { existsSync } from "fs";

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DATA_DIR = "data";

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR);
}

function dateStr(d: Date): string {
  return d.toISOString().split("T")[0];
}

async function fetchAndStore(client: PsegClient): Promise<void> {
  const now = new Date();

  // Fetch chart data (latest available readings)
  const chartData = await client.getChartData();
  const series = chartData.Data?.series?.[1];

  if (!series?.data?.length) {
    console.log(`[${now.toISOString()}] No chart data available`);
    return;
  }

  const last = series.data[series.data.length - 1];
  if (last && typeof last === "object" && "x" in last) {
    const readDate = new Date(last.x);
    console.log(
      `[${now.toISOString()}] Latest: ${readDate.toLocaleString()} = ${last.y} kWh`
    );
  }

  // Append latest data points to daily CSV
  const today = dateStr(now);
  const csvPath = `${DATA_DIR}/${today}.csv`;
  const isNew = !existsSync(csvPath);

  const rows: string[] = [];
  if (isNew) rows.push("timestamp,kWh,read_start,read_end");

  for (const point of series.data) {
    if (typeof point === "object" && "x" in point) {
      const ts = new Date(point.x).toISOString();
      const start = point.hs?.start ?? "";
      const end = point.hs?.end ?? "";
      rows.push(`${ts},${point.y},${start},${end}`);
    }
  }

  await appendFile(csvPath, rows.join("\n") + "\n");
}

async function createClient(): Promise<PsegClient> {
  try {
    const client = await PsegClient.create();
    // Test if session is alive
    await client.getChartData();
    return client;
  } catch {
    console.log("Session expired or invalid. Re-authenticating via Okta...");
    await oktaLogin();
    return PsegClient.create();
  }
}

async function main() {
  await ensureDataDir();
  console.log(
    `PSEG energy monitor started. Polling every ${POLL_INTERVAL_MS / 60000} minutes.`
  );

  let client = await createClient();
  let consecutiveErrors = 0;

  while (true) {
    try {
      await fetchAndStore(client);
      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      console.error(
        `[${new Date().toISOString()}] Error (${consecutiveErrors}):`,
        err.message
      );

      if (
        err.message.includes("Session expired") ||
        err.message.includes("expired")
      ) {
        try {
          console.log("Attempting re-login via Okta...");
          await oktaLogin();
          client = await PsegClient.create();
          console.log("Re-login successful.");
          consecutiveErrors = 0;
        } catch (loginErr: any) {
          console.error("Re-login failed:", loginErr.message);
        }
      }

      if (consecutiveErrors >= 5) {
        console.error("Too many consecutive errors. Exiting.");
        process.exit(1);
      }
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

main();
