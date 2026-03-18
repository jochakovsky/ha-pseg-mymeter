/**
 * Captcha solving service adapter.
 *
 * Supports multiple providers for reCAPTCHA v2 invisible solving.
 * Set one of these env vars:
 *   CAPSOLVER_API_KEY   — https://capsolver.com ($0.80/1K solves)
 *   TWOCAPTCHA_API_KEY  — https://2captcha.com ($1-3/1K solves)
 *
 * At ~96 solves/day max (every 15 min), cost is <$0.10/month with CapSolver.
 * In practice, you only need 1 solve per session (~1/day if daemon runs).
 */

const MYMETER_URL = "https://mysmartenergy.nj.pseg.com";
const RECAPTCHA_SITEKEY = "6LcbbJsUAAAAAHXQBPiWMaNvE9Tflw41mjYGJ3TV";

interface CaptchaProvider {
  name: string;
  createTask(): Promise<string>;
  getResult(taskId: string): Promise<string | null>;
}

function getCapSolver(apiKey: string): CaptchaProvider {
  const baseUrl = "https://api.capsolver.com";
  return {
    name: "CapSolver",
    async createTask() {
      const res = await fetch(`${baseUrl}/createTask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: apiKey,
          task: {
            type: "ReCaptchaV2TaskProxyLess",
            websiteURL: MYMETER_URL,
            websiteKey: RECAPTCHA_SITEKEY,
            isInvisible: true,
          },
        }),
      });
      const data = (await res.json()) as any;
      if (data.errorId && data.errorId !== 0) {
        throw new Error(`CapSolver createTask error: ${data.errorDescription}`);
      }
      return data.taskId;
    },
    async getResult(taskId: string) {
      const res = await fetch(`${baseUrl}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      });
      const data = (await res.json()) as any;
      if (data.errorId && data.errorId !== 0) {
        throw new Error(
          `CapSolver getResult error: ${data.errorDescription}`
        );
      }
      if (data.status === "ready") {
        return data.solution.gRecaptchaResponse as string;
      }
      return null; // still processing
    },
  };
}

function getTwoCaptcha(apiKey: string): CaptchaProvider {
  const baseUrl = "https://api.2captcha.com";
  return {
    name: "2Captcha",
    async createTask() {
      const res = await fetch(`${baseUrl}/createTask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: apiKey,
          task: {
            type: "RecaptchaV2TaskProxyless",
            websiteURL: MYMETER_URL,
            websiteKey: RECAPTCHA_SITEKEY,
            isInvisible: true,
          },
        }),
      });
      const data = (await res.json()) as any;
      if (data.errorId && data.errorId !== 0) {
        throw new Error(`2Captcha createTask error: ${data.errorDescription}`);
      }
      return data.taskId;
    },
    async getResult(taskId: string) {
      const res = await fetch(`${baseUrl}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      });
      const data = (await res.json()) as any;
      if (data.errorId && data.errorId !== 0) {
        throw new Error(`2Captcha getResult error: ${data.errorDescription}`);
      }
      if (data.status === "ready") {
        return data.solution.gRecaptchaResponse as string;
      }
      return null;
    },
  };
}

function getProvider(): CaptchaProvider {
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  if (capsolverKey) return getCapSolver(capsolverKey);

  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY;
  if (twocaptchaKey) return getTwoCaptcha(twocaptchaKey);

  throw new Error(
    "No captcha API key found. Set CAPSOLVER_API_KEY or TWOCAPTCHA_API_KEY in .env"
  );
}

/**
 * Solve reCAPTCHA v2 invisible for the MyMeter login page.
 * Returns the g-recaptcha-response token string.
 */
export async function solveCaptcha(): Promise<string> {
  const provider = getProvider();
  console.log(`Solving captcha via ${provider.name}...`);

  const taskId = await provider.createTask();
  const startTime = Date.now();
  const timeout = 120_000; // 2 minutes max

  while (Date.now() - startTime < timeout) {
    await Bun.sleep(3000);
    const result = await provider.getResult(taskId);
    if (result) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`Captcha solved in ${elapsed}s`);
      return result;
    }
  }

  throw new Error(`Captcha solving timed out after ${timeout / 1000}s`);
}
