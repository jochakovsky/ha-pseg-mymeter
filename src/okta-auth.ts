import { writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import type { PsegSessionCookies } from "./types";

const OKTA_BASE = "https://id.myaccount.pseg.com";
const MYMETER_BASE = "https://mysmartenergy.nj.pseg.com";
const MYMETER_SAML_SSO = `${OKTA_BASE}/app/psegnjb2c_mymeter_1/exktrfl7ruOTPxcyv357/sso/saml`;
const EMAIL_FACTOR_ID = "emf1by3eg2mEgGVZX358";
const COOKIE_PATH = "cookies.json";

/**
 * Authenticate to Okta via the authn API (no captcha).
 * Returns MFA_REQUIRED state with a stateToken.
 */
async function oktaPrimaryAuth(
  username: string,
  password: string
): Promise<string> {
  const res = await fetch(`${OKTA_BASE}/api/v1/authn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      password,
      options: {
        multiOptionalFactorEnroll: false,
        warnBeforePasswordExpired: false,
      },
    }),
  });
  const data = (await res.json()) as any;
  if (data.status !== "MFA_REQUIRED") {
    throw new Error(`Unexpected authn status: ${data.status}`);
  }
  return data.stateToken;
}

/** Trigger email MFA challenge. */
async function triggerEmailMfa(stateToken: string): Promise<void> {
  const res = await fetch(
    `${OKTA_BASE}/api/v1/authn/factors/${EMAIL_FACTOR_ID}/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stateToken }),
    }
  );
  const data = (await res.json()) as any;
  if (data.status !== "MFA_CHALLENGE") {
    throw new Error(`Failed to trigger MFA: ${data.status}`);
  }
}

/** Complete email MFA with the passcode. Returns a sessionToken. */
async function verifyEmailMfa(
  stateToken: string,
  passCode: string
): Promise<string> {
  const res = await fetch(
    `${OKTA_BASE}/api/v1/authn/factors/${EMAIL_FACTOR_ID}/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stateToken, passCode }),
    }
  );
  const data = (await res.json()) as any;
  if (data.status !== "SUCCESS") {
    throw new Error(
      `MFA verification failed: ${data.status} — ${data.factorResult ?? ""}`
    );
  }
  return data.sessionToken;
}

const OKTA_SESSION_FILE = "okta-session.json";

/**
 * Exchange a sessionToken for Okta session cookies and save them.
 * These can be reused to get new SAML assertions without MFA
 * for up to 60 minutes.
 */
async function saveOktaSessionCookies(sessionToken: string): Promise<void> {
  const res = await fetch(
    `${OKTA_BASE}/login/sessionCookieRedirect?token=${sessionToken}&redirectUrl=${encodeURIComponent(OKTA_BASE)}`,
    { redirect: "manual" }
  );
  const cookies = res.headers.getAll("set-cookie");
  const cookieStr = cookies.map((c) => c.split(";")[0]).join("; ");
  await writeFile(
    OKTA_SESSION_FILE,
    JSON.stringify({ cookies: cookieStr, savedAt: new Date().toISOString() }, null, 2)
  );
  console.log(`Saved Okta session cookies (${cookies.length} cookies) for silent refresh.`);
}

/**
 * Use a sessionToken to get a SAML assertion from Okta, then POST it to
 * MyMeter's ACS endpoint. Pure HTTP — no browser needed.
 *
 * The key insight: the SAMLResponse in Okta's HTML contains HTML entities
 * (e.g., &#x3d; for =) that must be decoded before URL-encoding for the
 * form POST. Without this, the ACS returns "Authentication Error".
 */
async function samlLogin(
  sessionToken: string
): Promise<PsegSessionCookies> {
  // Step 1: Get SAML assertion from Okta
  const samlRes = await fetch(
    `${MYMETER_SAML_SSO}?sessionToken=${sessionToken}`,
    { redirect: "manual" }
  );

  // Follow any redirects manually to reach the SSO endpoint
  let html: string;
  if (samlRes.status >= 300 && samlRes.status < 400) {
    const location = samlRes.headers.get("location")!;
    const res2 = await fetch(location, { redirect: "follow" });
    html = await res2.text();
  } else {
    html = await samlRes.text();
  }

  // Extract SAMLResponse and RelayState from the auto-submit form
  const samlMatch = html.match(
    /name="SAMLResponse"[^>]*value="([^"]+)"/
  );
  const relayMatch = html.match(
    /name="RelayState"[^>]*value="([^"]*?)"/
  );

  if (!samlMatch) {
    throw new Error("Could not extract SAMLResponse from Okta response");
  }

  // HTML-decode the values — this is critical!
  // Okta's HTML uses entities like &#x3d; for = in base64.
  const samlResponse = decodeHtmlEntities(samlMatch[1]);
  const relayState = relayMatch
    ? decodeHtmlEntities(relayMatch[1])
    : "";

  // Step 2: POST the SAML assertion to MyMeter's ACS
  const formBody = new URLSearchParams({
    SAMLResponse: samlResponse,
    RelayState: relayState,
  }).toString();

  const acsRes = await fetch(`${MYMETER_BASE}/saml/okta-prod/acs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": OKTA_BASE,
      "Referer": `${OKTA_BASE}/`,
    },
    body: formBody,
    redirect: "manual",
  });

  if (acsRes.status !== 302) {
    throw new Error(
      `SAML ACS returned ${acsRes.status} instead of 302 redirect`
    );
  }

  const location = acsRes.headers.get("location") ?? "";
  if (!location.includes("/Dashboard")) {
    throw new Error(`SAML ACS redirected to unexpected location: ${location}`);
  }

  // Extract cookies from the ACS response
  const cookies: PsegSessionCookies["cookies"] = [];
  for (const header of acsRes.headers.getSetCookie()) {
    const parsed = parseSetCookie(header);
    if (parsed) cookies.push(parsed);
  }

  if (!cookies.find((c) => c.name === "MM_SID")) {
    throw new Error("ACS response did not set MM_SID cookie");
  }

  // Step 3: Follow the redirect to Dashboard to get the CSRF token cookie
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const dashRes = await fetch(`${MYMETER_BASE}/Dashboard`, {
    headers: { cookie: cookieHeader },
    redirect: "follow",
  });
  await dashRes.text();

  // Merge any new cookies from the Dashboard response
  for (const header of dashRes.headers.getSetCookie()) {
    const parsed = parseSetCookie(header);
    if (parsed && !cookies.find((c) => c.name === parsed.name)) {
      cookies.push(parsed);
    }
  }

  return {
    cookies,
    savedAt: new Date().toISOString(),
  };
}

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

/**
 * Full Okta SAML login flow. No captcha, no browser required.
 *
 * 1. Okta primary auth (username/password)
 * 2. Trigger email MFA
 * 3. Verify MFA with code
 * 4. Get SAML assertion from Okta
 * 5. POST to MyMeter ACS → session cookies
 *
 * @param mfaCode If provided, skip waiting for stdin input
 */
export async function oktaLogin(
  mfaCode?: string
): Promise<PsegSessionCookies> {
  const username = process.env.PSEG_OKTA_USERNAME;
  const password = process.env.PSEG_OKTA_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "PSEG_OKTA_USERNAME and PSEG_OKTA_PASSWORD must be set in .env"
    );
  }

  // Step 1: Primary auth
  console.log("Authenticating with Okta...");
  const stateToken = await oktaPrimaryAuth(username, password);

  // Step 2: Trigger email MFA
  console.log("Triggering email MFA...");
  await triggerEmailMfa(stateToken);
  console.log("MFA code sent to email.");

  // Step 3: Get MFA code
  let code = mfaCode;
  if (!code) {
    process.stdout.write("Enter MFA code: ");
    for await (const line of console) {
      code = line.trim();
      break;
    }
    if (!code) throw new Error("No MFA code provided");
  }

  // Step 4: Verify MFA → sessionToken
  console.log("Verifying MFA code...");
  const sessionToken = await verifyEmailMfa(stateToken, code);

  // Step 5: Save Okta session cookies (for silent refresh later)
  console.log("Saving Okta session cookies...");
  await saveOktaSessionCookies(sessionToken);

  // Step 6: SAML login (pure HTTP, no browser)
  console.log("Performing SAML login...");
  const session = await samlLogin(sessionToken);

  // Save cookies
  await writeFile(COOKIE_PATH, JSON.stringify(session, null, 2));
  console.log(
    `Login successful. Saved ${session.cookies.length} cookies to ${COOKIE_PATH}`
  );

  return session;
}

// Re-export shared utilities from auth.ts
export { loadCookies, cookieHeader } from "./auth";

if (import.meta.main) {
  // Accept MFA code as CLI argument: bun run src/okta-auth.ts 123456
  const cliCode = process.argv.find((a) => /^\d{6}$/.test(a));
  await oktaLogin(cliCode);
}
