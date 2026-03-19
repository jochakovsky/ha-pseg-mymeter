/**
 * Okta session persistence test.
 *
 * When we do the SAML flow, Okta gives us a sessionToken. If we exchange that
 * for Okta session cookies, we might be able to reuse those cookies to get
 * new SAML assertions (and thus new MyMeter sessions) without MFA.
 *
 * Okta session lifetime is typically 2 hours by default, but can be configured
 * up to 30 days. If it's longer than MyMeter's ~30 min timeout, we can use it
 * as a session refresh mechanism.
 *
 * Flow:
 * 1. Check if we have saved Okta session cookies
 * 2. Try to hit the SAML SSO endpoint with those cookies
 * 3. If it returns a SAML assertion, we can refresh MyMeter without MFA
 *
 * Also explores:
 * - Okta session API to check session lifetime
 * - Whether Okta "remember device" can extend MFA skip window
 */

const OKTA_BASE = "https://id.myaccount.pseg.com";
const MYMETER_BASE = "https://mysmartenergy.nj.pseg.com";
const MYMETER_SAML_SSO = `${OKTA_BASE}/app/psegnjb2c_mymeter_1/exktrfl7ruOTPxcyv357/sso/saml`;
const OKTA_SESSION_FILE = "okta-session.json";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";

interface OktaSession {
  cookies: string; // raw cookie header string
  savedAt: string;
}

async function loadOktaSession(): Promise<OktaSession | null> {
  if (!existsSync(OKTA_SESSION_FILE)) return null;
  return JSON.parse(await readFile(OKTA_SESSION_FILE, "utf-8"));
}

async function saveOktaSession(cookies: string): Promise<void> {
  await writeFile(
    OKTA_SESSION_FILE,
    JSON.stringify({ cookies, savedAt: new Date().toISOString() }, null, 2)
  );
}

/**
 * Step 1: Exchange a sessionToken for Okta session cookies.
 * The sessionToken comes from the authn API after MFA.
 * We redirect to Okta's login endpoint which sets session cookies.
 */
async function exchangeTokenForCookies(sessionToken: string): Promise<string> {
  // Okta's session cookie endpoint
  const res = await fetch(
    `${OKTA_BASE}/login/sessionCookieRedirect?token=${sessionToken}&redirectUrl=${encodeURIComponent(OKTA_BASE)}`,
    {
      redirect: "manual",
      headers: { "user-agent": UA },
    }
  );

  const cookies = res.headers.getAll("set-cookie");
  console.log(`Session cookie exchange: ${res.status}`);
  console.log(`Location: ${res.headers.get("location") ?? "none"}`);
  console.log(`Cookies set: ${cookies.length}`);

  const cookieParts: string[] = [];
  for (const c of cookies) {
    const [nameVal] = c.split(";");
    const name = nameVal.split("=")[0];
    const parts = c.split(";").map((p) => p.trim().toLowerCase());
    const expiry = parts.find((p) => p.startsWith("expires="));
    const maxAge = parts.find((p) => p.startsWith("max-age="));
    console.log(`  ${name}: ${expiry ?? ""} ${maxAge ?? ""}`);
    cookieParts.push(nameVal);
  }

  const cookieStr = cookieParts.join("; ");
  await saveOktaSession(cookieStr);
  return cookieStr;
}

/**
 * Step 2: Check if Okta session is still alive.
 */
async function checkOktaSession(cookies: string): Promise<boolean> {
  // Okta sessions API
  const res = await fetch(`${OKTA_BASE}/api/v1/sessions/me`, {
    headers: {
      "user-agent": UA,
      cookie: cookies,
      accept: "application/json",
    },
  });

  if (res.status === 200) {
    const data = (await res.json()) as any;
    console.log("Okta session info:");
    console.log(`  Status: ${data.status}`);
    console.log(`  Created: ${data.createdAt}`);
    console.log(`  Expires: ${data.expiresAt}`);
    console.log(`  Last login: ${data.lastPasswordVerification}`);
    console.log(`  MFA factor: ${data.amr?.join(", ") ?? "none"}`);
    if (data.expiresAt) {
      const remaining =
        (new Date(data.expiresAt).getTime() - Date.now()) / 60000;
      console.log(`  Time remaining: ${remaining.toFixed(1)} minutes`);
    }
    return true;
  } else {
    console.log(`Okta session check: ${res.status} (expired)`);
    return false;
  }
}

/**
 * Step 3: Try to get a SAML assertion using existing Okta session cookies.
 * If this works, we can refresh MyMeter without MFA!
 */
async function trySamlWithSession(cookies: string): Promise<boolean> {
  console.log("\nAttempting SAML assertion with Okta session cookies...");

  const res = await fetch(MYMETER_SAML_SSO, {
    headers: {
      "user-agent": UA,
      cookie: cookies,
    },
    redirect: "manual",
  });

  console.log(`SAML SSO status: ${res.status}`);
  const location = res.headers.get("location") ?? "";
  if (location) console.log(`Location: ${location}`);

  // Collect any new cookies
  const newCookies = res.headers.getAll("set-cookie");
  if (newCookies.length > 0) {
    console.log(`New cookies: ${newCookies.length}`);
    // Merge new cookies
    const mergedParts = cookies.split("; ");
    for (const c of newCookies) {
      const nameVal = c.split(";")[0];
      const name = nameVal.split("=")[0];
      const idx = mergedParts.findIndex((p) => p.startsWith(name + "="));
      if (idx >= 0) mergedParts[idx] = nameVal;
      else mergedParts.push(nameVal);
    }
    cookies = mergedParts.join("; ");
  }

  // Follow redirects
  if (res.status >= 300 && res.status < 400 && location) {
    console.log("Following redirect...");
    const res2 = await fetch(location, {
      headers: { "user-agent": UA, cookie: cookies },
      redirect: "manual",
    });
    console.log(`Redirect target status: ${res2.status}`);
    const loc2 = res2.headers.get("location") ?? "";
    if (loc2) console.log(`Location: ${loc2}`);

    // Merge cookies again
    for (const c of res2.headers.getAll("set-cookie")) {
      const nameVal = c.split(";")[0];
      const name = nameVal.split("=")[0];
      cookies = cookies
        .split("; ")
        .filter((p) => !p.startsWith(name + "="))
        .concat([nameVal])
        .join("; ");
    }

    // If we got another redirect, follow that too
    if (res2.status >= 300 && res2.status < 400 && loc2) {
      console.log("Following second redirect...");
      const res3 = await fetch(loc2, {
        headers: { "user-agent": UA, cookie: cookies },
        redirect: "follow",
      });
      const html = await res3.text();

      // Check for SAML assertion
      if (html.includes("SAMLResponse")) {
        console.log("✅ Got SAML assertion from Okta using session cookies!");
        const match = html.match(
          /name="SAMLResponse"[^>]*value="([^"]+)"/
        );
        if (match) {
          console.log(
            `  SAMLResponse: ${match[1].slice(0, 50)}... (${match[1].length} chars)`
          );
          return true;
        }
      } else if (html.includes("LoginEmail") || html.includes("username")) {
        console.log(
          "💀 Okta session expired — returned login page"
        );
      } else {
        console.log(`Response: ${html.slice(0, 300)}`);
      }

      return false;
    }

    const html2 = await res2.text();
    if (html2.includes("SAMLResponse")) {
      console.log("✅ Got SAML assertion!");
      return true;
    } else {
      console.log(`Response: ${html2.slice(0, 300)}`);
    }

    return false;
  }

  // Direct 200 response — check for SAML form
  const html = await res.text();
  if (html.includes("SAMLResponse")) {
    console.log("✅ Got SAML assertion directly!");
    const match = html.match(/name="SAMLResponse"[^>]*value="([^"]+)"/);
    if (match) {
      console.log(
        `  SAMLResponse: ${match[1].slice(0, 50)}... (${match[1].length} chars)`
      );
    }
    return true;
  } else if (
    html.includes("Sign In") ||
    html.includes("username") ||
    html.includes("password")
  ) {
    console.log("💀 Okta session expired — returned login/MFA page");
    console.log(`  Page contains: ${html.includes("MFA") ? "MFA" : "login"} prompt`);
  } else {
    console.log(`Response (${html.length} chars): ${html.slice(0, 300)}`);
  }

  return false;
}

/**
 * Step 4: Full Okta auth to get fresh session cookies (for testing).
 */
const STATE_TOKEN_FILE = "okta-state.json";

/**
 * Step 1 of auth: primary auth + trigger MFA. Saves stateToken to file.
 * Run this first, then run "verify <code>" with the emailed code.
 */
async function triggerMfa(): Promise<void> {
  const username = process.env.PSEG_OKTA_USERNAME;
  const password = process.env.PSEG_OKTA_PASSWORD;
  if (!username || !password) {
    throw new Error("PSEG_OKTA_USERNAME and PSEG_OKTA_PASSWORD required");
  }

  console.log("Authenticating with Okta (primary auth)...");
  const authRes = await fetch(`${OKTA_BASE}/api/v1/authn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const authData = (await authRes.json()) as any;

  if (authData.status !== "MFA_REQUIRED") {
    throw new Error(`Unexpected status: ${authData.status}`);
  }

  const stateToken = authData.stateToken;
  const emailFactorId = "emf1by3eg2mEgGVZX358";

  console.log("Triggering email MFA...");
  await fetch(`${OKTA_BASE}/api/v1/authn/factors/${emailFactorId}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stateToken }),
  });

  await writeFile(
    STATE_TOKEN_FILE,
    JSON.stringify({ stateToken, savedAt: new Date().toISOString() })
  );
  console.log("MFA email sent. Now run:");
  console.log("  bun src/okta-session-test.ts verify <6-digit-code>");
}

/**
 * Step 2 of auth: verify MFA code using saved stateToken.
 */
async function verifyMfa(code: string): Promise<string> {
  if (!existsSync(STATE_TOKEN_FILE)) {
    throw new Error("No saved state token. Run 'auth' first.");
  }
  const { stateToken } = JSON.parse(await readFile(STATE_TOKEN_FILE, "utf-8"));
  const emailFactorId = "emf1by3eg2mEgGVZX358";

  console.log("Verifying MFA...");
  const verifyRes = await fetch(
    `${OKTA_BASE}/api/v1/authn/factors/${emailFactorId}/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stateToken, passCode: code }),
    }
  );
  const verifyData = (await verifyRes.json()) as any;
  if (verifyData.status !== "SUCCESS") {
    console.error("MFA response:", JSON.stringify(verifyData, null, 2));
    throw new Error(`MFA failed: ${verifyData.status ?? verifyData.errorCode}`);
  }

  const sessionToken = verifyData.sessionToken;
  console.log(`Got sessionToken: ${sessionToken.slice(0, 20)}...`);

  // Clean up state file
  const { unlink } = await import("fs/promises");
  await unlink(STATE_TOKEN_FILE).catch(() => {});

  // Exchange for Okta session cookies
  return await exchangeTokenForCookies(sessionToken);
}

async function main() {
  const mode = process.argv[2] ?? "check";

  if (mode === "auth") {
    // Step 1: primary auth + trigger MFA
    await triggerMfa();
  } else if (mode === "verify") {
    // Step 2: verify MFA code + exchange for session cookies
    const code = process.argv[3];
    if (!code || !/^\d{6}$/.test(code)) {
      console.error("Usage: bun src/okta-session-test.ts verify <6-digit-code>");
      process.exit(1);
    }
    const cookies = await verifyMfa(code);
    console.log("\nOkta session cookies saved. Now checking session...");
    await checkOktaSession(cookies);
    console.log("\nNow attempting SAML assertion...");
    await trySamlWithSession(cookies);
  } else if (mode === "check") {
    // Check existing Okta session
    const session = await loadOktaSession();
    if (!session) {
      console.log(
        "No saved Okta session. Run with 'auth' to authenticate:\n  bun src/okta-session-test.ts auth"
      );
      return;
    }

    const age =
      (Date.now() - new Date(session.savedAt).getTime()) / 60000;
    console.log(`Okta session age: ${age.toFixed(1)} min`);

    const alive = await checkOktaSession(session.cookies);
    if (alive) {
      await trySamlWithSession(session.cookies);
    }
  } else if (mode === "saml") {
    // Just try SAML with existing session
    const session = await loadOktaSession();
    if (!session) {
      console.log("No saved Okta session.");
      return;
    }
    await trySamlWithSession(session.cookies);
  } else {
    console.log("Usage:");
    console.log("  bun src/okta-session-test.ts auth   — fresh Okta auth + save session");
    console.log("  bun src/okta-session-test.ts check  — check saved Okta session");
    console.log("  bun src/okta-session-test.ts saml   — try SAML with saved session");
  }
}

main().catch(console.error);
