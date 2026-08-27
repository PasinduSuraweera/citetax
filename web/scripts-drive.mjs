import { chromium } from "playwright";

const OUT = process.env.SHOT_DIR ?? ".";
const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage({ viewport: { width: 1560, height: 1100 } });

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

async function shot(name, opts = {}) {
  await page.waitForTimeout(opts.wait ?? 700);
  await page.screenshot({ path: `${OUT}\\${name}.png`, fullPage: opts.full ?? false });
  console.log(`  captured ${name}`);
}

// --- public app still works ---
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await shot("a1-ask");

await page.locator("textarea").fill(
  "What do I owe for 2026/2027 on a salary of LKR 250,000 a month, with EPF deducted?"
);
await page.getByRole("button", { name: "Ask", exact: true }).click();
await page.waitForSelector("text=BALANCE PAYABLE", { timeout: 90000 });
await shot("a2-answer", { full: true });
const guard = await page.locator("text=Released by guardrail").count();
console.log("  guardrail released:", guard > 0);

// --- sign in page ---
await page.goto("http://localhost:3000/signin", { waitUntil: "networkidle" });
await shot("a3-signin");
console.log("  google button:", await page.locator("text=Continue with Google").count() > 0);

// --- history asks for sign in rather than erroring ---
await page.goto("http://localhost:3000/history", { waitUntil: "networkidle" });
await shot("a4-history");
console.log("  history prompts sign in:",
  await page.locator("text=SIGN IN TO SEE YOUR HISTORY").count() > 0);

// --- admin refuses without a reviewer role ---
await page.goto("http://localhost:3000/admin", { waitUntil: "networkidle" });
await shot("a5-admin-noaccess", { wait: 1800 });
console.log("  admin gated:",
  await page.locator("text=You do not have reviewer access").count() > 0);

// --- other public routes unaffected ---
for (const [path, name] of [["/compare", "a6-compare"], ["/deadlines", "a7-deadlines"]]) {
  await page.goto(`http://localhost:3000${path}`, { waitUntil: "networkidle" });
  await shot(name, { wait: 1400 });
}

console.log("\nconsole errors:", errors.length);
errors.slice(0, 8).forEach((e) => console.log("   !", e.slice(0, 180)));
await browser.close();
