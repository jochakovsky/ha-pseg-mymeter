import { writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import type { PsegSessionCookies } from "./types";

const OKTA_BASE = "https://id.myaccount.pseg.com";
const MYMETER_EMBED =
  "https://id.myaccount.pseg.com/home/psegnjb2c_mymeter_1/0oatrfl7rvCa020fu357/alntrg33dfnhspzDf357";
const EMAIL_FACTOR_ID = "emf1by3eg2mEgGVZX358";
const COOKIE_PATH = "cookies.json";

interface OktaSession {
  sessionToken: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
  }>;
}

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

/**
 * Exchange a sessionToken for Okta session cookies by hitting the SAML SSO
 * endpoint. Returns cookies suitable for Playwright injection.
 */
async function getOktaSessionCookies(
  sessionToken: string
): Promise<OktaSession["cookies"]> {
  const url = `${OKTA_BASE}/app/psegnjb2c_mymeter_1/exktrfl7ruOTPxcyv357/sso/saml?sessionToken=${sessionToken}`;
  const res = await fetch(url, { redirect: "manual" });

  const cookies: OktaSession["cookies"] = [];
  for (const header of res.headers.getSetCookie()) {
    const [nameValue, ...parts] = header.split(";");
    const [name, ...valueParts] = nameValue.split("=");
    const value = valueParts.join("=");
    const isSecure = parts.some((p) => p.trim().toLowerCase() === "secure");
    const isHttpOnly = parts.some(
      (p) => p.trim().toLowerCase() === "httponly"
    );
    const pathMatch = parts.find((p) =>
      p.trim().toLowerCase().startsWith("path=")
    );
    const path = pathMatch ? pathMatch.trim().split("=")[1] : "/";

    if (name && value) {
      cookies.push({
        name: name.trim(),
        value: value.trim(),
        domain: "id.myaccount.pseg.com",
        path,
        secure: isSecure,
        httpOnly: isHttpOnly,
      });
    }
  }

  // Also consume the response body (SAML form) — we don't need it,
  // Playwright will redo this navigation with the cookies.
  await res.text();

  return cookies;
}

/**
 * Use Playwright to navigate to the MY METER embed link with Okta session
 * cookies. The browser handles the SAML form auto-submit and we extract
 * the resulting MyMeter session cookies.
 */
async function samlLoginViaPlaywright(
  oktaCookies: OktaSession["cookies"],
  headless: boolean
): Promise<PsegSessionCookies> {
  const { chromium } = await import("playwright");

  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    });

    await context.addCookies(oktaCookies);
    const page = await context.newPage();

    await page.goto(MYMETER_EMBED, {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    const url = page.url();
    if (!url.includes("/Dashboard")) {
      const errorCount = await page
        .locator("text=Authentication Error")
        .count();
      if (errorCount > 0) {
        throw new Error(
          "SAML authentication failed — Okta identity not linked to MyMeter account"
        );
      }
      throw new Error(`Unexpected page after SAML login: ${url}`);
    }

    const cookies = await context.cookies();
    const session: PsegSessionCookies = {
      cookies: cookies
        .filter((c) => c.domain.includes("mysmartenergy"))
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite as "Strict" | "Lax" | "None",
        })),
      savedAt: new Date().toISOString(),
    };

    return session;
  } finally {
    await browser.close();
  }
}

/**
 * Full Okta SAML login flow. No captcha required.
 *
 * 1. Okta primary auth (username/password)
 * 2. Trigger email MFA
 * 3. Wait for MFA code (from stdin or provided)
 * 4. Get Okta session cookies
 * 5. Playwright SAML flow → MyMeter cookies
 *
 * @param mfaCode If provided, skip waiting for stdin input
 * @param headless Run Playwright in headless mode (default: true)
 */
export async function oktaLogin(
  mfaCode?: string,
  headless = true
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

  // Step 5: Get Okta session cookies
  console.log("Establishing Okta session...");
  const oktaCookies = await getOktaSessionCookies(sessionToken);
  console.log(`Got ${oktaCookies.length} Okta cookies.`);

  // Step 6: Playwright SAML → MyMeter cookies
  console.log(`Performing SAML login (headless=${headless})...`);
  const session = await samlLoginViaPlaywright(oktaCookies, headless);

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
  const headless = !process.argv.includes("--headed");
  // Accept MFA code as CLI argument: bun run src/okta-auth.ts 123456
  const cliCode = process.argv.find((a) => /^\d{6}$/.test(a));
  await oktaLogin(cliCode, headless);
}
