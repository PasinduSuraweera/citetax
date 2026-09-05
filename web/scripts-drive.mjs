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

// Playwright's text= selector is a case-insensitive substring match, and the
// loading screen plus sidebar contain words like "what changed" and "due", so
// wait for something that only exists once an answer has rendered: the
// guardrail banner, the refusal eyebrow, or the clarify eyebrow.
const SETTLED = "text=/Released by guardrail|Explanation withheld|Cannot answer|Outside scope|ONE MORE THING|CANNOT REACH THE API/";

async function askAndWait(q, marker) {
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.locator("textarea").fill(q);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.waitForSelector(SETTLED, { timeout: 150000 });
  await page.waitForTimeout(700);
  const ok = (await page.locator(marker).count()) > 0;
  console.log(`  marker ${marker}: ${ok ? "present" : "MISSING"}`);
}

// --- ask screen: sign-in affordance in the rail ---
await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await shot("b1-ask");
console.log("  sign in in rail:", (await page.locator("aside >> text=Sign in").count()) > 0);
console.log("  6 example chips:", await page.locator("text=TRY ONE").count() > 0);

// --- compute intent ---
await askAndWait("What do I owe for 2026/2027 on a salary of LKR 250,000 a month, with EPF deducted?", "text=BALANCE PAYABLE");
await shot("b2-compute", { full: true });
console.log("  intent chip compute:", (await page.locator("text=compute").first().count()) > 0);
await page.getByRole("tab", { name: "Agent trace" }).click();
await shot("b3-trace-compute", { wait: 500 });
const planNodes = await page.locator("ol li").count();
console.log("  trace nodes rendered:", planNodes);
if (await page.getByRole("tab", { name: /Sources/ }).count()) {
  await page.getByRole("tab", { name: /Sources/ }).click();
  await shot("b4-sources", { wait: 500 });
  console.log("  sources tab present: true");
} else {
  console.log("  sources tab present: false (nothing retrieved)");
}

// --- deadline intent: no ledger, date headline ---
await askAndWait("When is my return due for 2025/2026?", "text=RETURN DUE");
await shot("b5-deadline", { full: true });
console.log("  no Computation tab on deadline:", (await page.getByRole("tab", { name: "Computation" }).count()) === 0);
console.log("  instalments shown:", (await page.locator("text=QUARTERLY INSTALMENTS").count()) > 0);

// --- rule lookup ---
await askAndWait("What is the personal relief for 2026/2027?", "text=IN FORCE FOR");
await shot("b6-rule-lookup", { full: true });

// --- compare intent ---
await askAndWait("What changed between 2025/2026 and 2026/2027?", "text=WHAT CHANGED");
await shot("b7-compare-answer", { full: true });
console.log("  comparison tab:", (await page.getByRole("tab", { name: "Comparison" }).count()) > 0);

// --- general intent (the one that was misrouted) ---
await askAndWait("How does APIT work for a salaried employee?", "text=Agent trace");
await shot("b8-general", { full: true });
const refused = await page.locator("text=REFUSED").count();
console.log("  APIT general question answered (not refused):", refused === 0);

// --- clarify ---
await askAndWait("How much tax do I owe?", "text=ONE MORE THING");
await shot("b9-clarify");

// --- refusal ---
await askAndWait("How do I register for VAT?", "text=REFUSED");
await shot("b10-refusal");

// --- compare page, deadlines page ---
await page.goto("http://localhost:3000/compare", { waitUntil: "networkidle" });
await shot("b11-compare-page", { wait: 1500, full: true });
console.log("  changelog timeline:", (await page.locator("text=CORPUS CHANGELOG").count()) > 0);

await page.goto("http://localhost:3000/deadlines", { waitUntil: "networkidle" });
await shot("b12-deadlines-page", { wait: 1500, full: true });
console.log("  other year card:", (await page.locator("text=THE OTHER YEAR").count()) > 0);

// --- history signed out ---
await page.goto("http://localhost:3000/history", { waitUntil: "networkidle" });
await shot("b13-history-signed-out", { wait: 1200 });

// --- admin gated ---
await page.goto("http://localhost:3000/admin/agent", { waitUntil: "networkidle" });
await shot("b14-admin-gated", { wait: 1600 });
console.log("  admin gated:", (await page.locator("text=You do not have reviewer access").count()) > 0);

console.log("\nconsole errors:", errors.length);
const real = errors.filter((e) => !e.includes("401"));
console.log("non-401 errors:", real.length);
real.slice(0, 8).forEach((e) => console.log("   !", e.slice(0, 200)));
await browser.close();
