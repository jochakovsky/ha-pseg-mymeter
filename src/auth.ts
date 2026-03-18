import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import type { PsegSessionCookies } from "./types";

const MYMETER_BASE = "https://mysmartenergy.nj.pseg.com";
const COOKIE_PATH = "cookies.json";

/**
 * Login to MyMeter using Playwright.
 *
 * Uses headed Chromium to fill in email/password and submit the login form.
 * reCAPTCHA v2 invisible passes automatically in headed mode without user
 * interaction. Falls back to waiting 120s for manual captcha solving if needed.
 */
export async function login(): Promise<PsegSessionCookies> {
  const email = process.env.PSEG_EMAIL;
  const password = process.env.PSEG_PASSWORD;
  if (!email || !password) {
    throw new Error("PSEG_EMAIL and PSEG_PASSWORD must be set in .env");
  }

  const { chromium } = await import("playwright");

  console.log("Launching browser for MyMeter login...");
  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    await page.goto(MYMETER_BASE);
    await page.waitForSelector("#LoginEmail", { timeout: 15000 });

    await page.fill("#LoginEmail", email);
    await page.fill("#LoginPassword", password);
    await page.check("#RememberMe");
    await page.click("button.loginBtn");

    // Wait for redirect to Dashboard (captcha usually resolves automatically)
    try {
      await page.waitForURL("**/Dashboard**", { timeout: 30000 });
    } catch {
      console.log(
        "Waiting for login to complete (captcha may need manual solving)..."
      );
      await page.waitForURL("**/Dashboard**", { timeout: 120000 });
    }

    console.log("Login successful.");

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

    await writeFile(COOKIE_PATH, JSON.stringify(session, null, 2));
    console.log(`Saved ${session.cookies.length} cookies to ${COOKIE_PATH}`);

    return session;
  } finally {
    await browser.close();
  }
}

export async function loadCookies(): Promise<PsegSessionCookies | null> {
  if (!existsSync(COOKIE_PATH)) return null;
  const raw = await readFile(COOKIE_PATH, "utf-8");
  return JSON.parse(raw) as PsegSessionCookies;
}

export function cookieHeader(session: PsegSessionCookies): string {
  return session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

if (import.meta.main) {
  await login();
}
