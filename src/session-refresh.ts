/**
 * Session refresh: use saved Okta session cookies to get a fresh MyMeter session.
 * No MFA required — just Okta session cookies → SAML assertion → MyMeter cookies.
 *
 * Usage:
 *   bun src/session-refresh.ts           # refresh MyMeter session
 *   bun src/session-refresh.ts --status  # check both session statuses
 */

import { loadCookies, cookieHeader } from "./auth";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import type { PsegSessionCookies } from "./types";

const OKTA_BASE = "https://id.myaccount.pseg.com";
const MYMETER_BASE = "https://mysmartenergy.nj.pseg.com";
const MYMETER_SAML_SSO = `${OKTA_BASE}/app/psegnjb2c_mymeter_1/exktrfl7ruOTPxcyv357/sso/saml`;
const OKTA_SESSION_FILE = "okta-session.json";
const COOKIE_PATH = "cookies.json";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCharCode(parseInt(dec, 10))
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseSetCookie(
  header: string
): PsegSessionCookies["cookies"][0] | null {
  const [nameValue, ...parts] = header.split(";");
  const eqIdx = nameValue.indexOf("=");
  if (eqIdx === -1) return null;

  const name = nameValue.substring(0, eqIdx).trim();
  const value = nameValue.substring(eqIdx + 1).trim();
  if (!name) return null;

  const lower = parts.map((p) => p.trim().toLowerCase());
  const pathPart = lower.find((p) => p.startsWith("path="));
  const sameSitePart = lower.find((p) => p.startsWith("samesite="));

  return {
    name,
    value,
    domain: "mysmartenergy.nj.pseg.com",
    path: pathPart ? pathPart.split("=")[1] : "/",
    expires: -1,
    httpOnly: lower.some((p) => p === "httponly"),
    secure: lower.some((p) => p === "secure"),
    sameSite: sameSitePart
      ? ((sameSitePart.split("=")[1].charAt(0).toUpperCase() +
          sameSitePart.split("=")[1].slice(1)) as "Strict" | "Lax" | "None")
      : "Lax",
  };
}

export async function loadOktaSession(): Promise<{ cookies: string; savedAt: string } | null> {
  if (!existsSync(OKTA_SESSION_FILE)) return null;
  return JSON.parse(await readFile(OKTA_SESSION_FILE, "utf-8"));
}

export async function checkOktaSession(
  cookies: string
): Promise<{ alive: boolean; remaining: number }> {
  const res = await fetch(`${OKTA_BASE}/api/v1/sessions/me`, {
    headers: { "user-agent": UA, cookie: cookies, accept: "application/json" },
  });
  if (res.status === 200) {
    const data = (await res.json()) as any;
    const remaining = data.expiresAt
      ? (new Date(data.expiresAt).getTime() - Date.now()) / 60000
      : 0;
    return { alive: true, remaining };
  }
  return { alive: false, remaining: 0 };
}

async function checkMyMeterSession(): Promise<boolean> {
  const session = await loadCookies();
  if (!session) return false;

  const res = await fetch(`${MYMETER_BASE}/Dashboard/ChartData?_=${Date.now()}`, {
    headers: {
      "user-agent": UA,
      cookie: cookieHeader(session),
      "x-requested-with": "XMLHttpRequest",
    },
    redirect: "manual",
  });
  const text = await res.text();
  // Alive if we get actual chart data (has "series" key)
  return text.includes('"series"');
}

/**
 * Use Okta session cookies to get a SAML assertion,
 * then POST it to MyMeter ACS for a fresh session.
 */
export async function refreshMyMeter(oktaCookies: string): Promise<PsegSessionCookies> {
  // Step 1: Get SAML assertion from Okta
  const samlRes = await fetch(MYMETER_SAML_SSO, {
    headers: { "user-agent": UA, cookie: oktaCookies },
    redirect: "manual",
  });

  // Handle redirects
  let html: string;
  let updatedCookies = oktaCookies;
  if (samlRes.status >= 300 && samlRes.status < 400) {
    const location = samlRes.headers.get("location")!;
    // Merge any cookies from redirect
    for (const c of samlRes.headers.getAll("set-cookie")) {
      const nameVal = c.split(";")[0];
      const name = nameVal.split("=")[0];
      updatedCookies = updatedCookies
        .split("; ")
        .filter((p) => !p.startsWith(name + "="))
        .concat([nameVal])
        .join("; ");
    }
    const res2 = await fetch(location, {
      headers: { "user-agent": UA, cookie: updatedCookies },
      redirect: "follow",
    });
    html = await res2.text();
  } else {
    html = await samlRes.text();
  }

  const samlMatch = html.match(/name="SAMLResponse"[^>]*value="([^"]+)"/);
  if (!samlMatch) {
    if (html.includes("Sign In") || html.includes("username")) {
      throw new Error("Okta session expired — need to re-authenticate with MFA");
    }
    throw new Error("Could not extract SAMLResponse from Okta");
  }

  const samlResponse = decodeHtmlEntities(samlMatch[1]);
  const relayMatch = html.match(/name="RelayState"[^>]*value="([^"]*?)"/);
  const relayState = relayMatch ? decodeHtmlEntities(relayMatch[1]) : "";

  // Step 2: POST to MyMeter ACS
  const formBody = new URLSearchParams({
    SAMLResponse: samlResponse,
    RelayState: relayState,
  }).toString();

  const acsRes = await fetch(`${MYMETER_BASE}/saml/okta-prod/acs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: OKTA_BASE,
      Referer: `${OKTA_BASE}/`,
    },
    body: formBody,
    redirect: "manual",
  });

  if (acsRes.status !== 302) {
    throw new Error(`ACS returned ${acsRes.status} instead of 302`);
  }

  // Extract cookies
  const cookies: PsegSessionCookies["cookies"] = [];
  for (const header of acsRes.headers.getAll("set-cookie")) {
    const parsed = parseSetCookie(header);
    if (parsed) cookies.push(parsed);
  }

  if (!cookies.find((c) => c.name === "MM_SID")) {
    throw new Error("ACS did not set MM_SID cookie");
  }

  // Step 3: Hit Dashboard to get CSRF token cookie
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const dashRes = await fetch(`${MYMETER_BASE}/Dashboard`, {
    headers: { cookie: cookieStr, "user-agent": UA },
    redirect: "follow",
  });
  await dashRes.text();

  for (const header of dashRes.headers.getAll("set-cookie")) {
    const parsed = parseSetCookie(header);
    if (parsed && !cookies.find((c) => c.name === parsed.name)) {
      cookies.push(parsed);
    }
  }

  const session: PsegSessionCookies = {
    cookies,
    savedAt: new Date().toISOString(),
  };

  await writeFile(COOKIE_PATH, JSON.stringify(session, null, 2));
  return session;
}

/**
 * Try to refresh MyMeter using saved Okta session cookies.
 * Returns the new session if successful, null if Okta session is expired.
 */
export async function refreshFromOktaSession(): Promise<PsegSessionCookies | null> {
  const okta = await loadOktaSession();
  if (!okta) return null;

  const status = await checkOktaSession(okta.cookies);
  if (!status.alive) return null;

  return refreshMyMeter(okta.cookies);
}

async function showStatus() {
  console.log("=== Session Status ===\n");

  // Okta session
  const okta = await loadOktaSession();
  if (okta) {
    const age = (Date.now() - new Date(okta.savedAt).getTime()) / 60000;
    const status = await checkOktaSession(okta.cookies);
    if (status.alive) {
      console.log(`Okta:    ✅ ALIVE (${status.remaining.toFixed(0)} min remaining, age ${age.toFixed(0)} min)`);
    } else {
      console.log(`Okta:    💀 EXPIRED (age ${age.toFixed(0)} min)`);
    }
  } else {
    console.log("Okta:    ❌ No saved session");
  }

  // MyMeter session
  const mymeter = await loadCookies();
  if (mymeter) {
    const age = (Date.now() - new Date(mymeter.savedAt).getTime()) / 60000;
    const alive = await checkMyMeterSession();
    if (alive) {
      console.log(`MyMeter: ✅ ALIVE (age ${age.toFixed(0)} min)`);
    } else {
      console.log(`MyMeter: 💀 EXPIRED (age ${age.toFixed(0)} min)`);
    }
  } else {
    console.log("MyMeter: ❌ No saved session");
  }
}

async function main() {
  const mode = process.argv.includes("--status") ? "status" : "refresh";

  if (mode === "status") {
    await showStatus();
    return;
  }

  // Refresh flow
  const okta = await loadOktaSession();
  if (!okta) {
    console.error("No Okta session. Run:");
    console.error("  bun src/okta-session-test.ts auth");
    console.error("  bun src/okta-session-test.ts verify <code>");
    process.exit(1);
  }

  // Check Okta session health
  const status = await checkOktaSession(okta.cookies);
  if (!status.alive) {
    console.error("Okta session expired. Need to re-authenticate:");
    console.error("  bun src/okta-session-test.ts auth");
    process.exit(1);
  }
  console.log(`Okta session: ${status.remaining.toFixed(0)} min remaining`);

  // Check if MyMeter even needs refreshing
  const mymeterAlive = await checkMyMeterSession();
  if (mymeterAlive) {
    console.log("MyMeter session is already alive — no refresh needed.");
    return;
  }

  // Refresh!
  console.log("MyMeter session expired. Refreshing via Okta SAML...");
  const session = await refreshMyMeter(okta.cookies);
  console.log(
    `✅ MyMeter refreshed! ${session.cookies.length} cookies saved to ${COOKIE_PATH}`
  );

  // Verify it works
  const verify = await checkMyMeterSession();
  console.log(verify ? "✅ Verified: ChartData returns data." : "⚠️  Refresh succeeded but ChartData not working.");
}

main().catch(console.error);
