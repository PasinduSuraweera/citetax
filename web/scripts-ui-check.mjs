/**
 * UI regression drive: the two reported bugs, plus mobile layout on every page.
 *
 * Desktop at 1560x1100, phone at 390x844 (iPhone 14 metrics).
 */
import { chromium, devices } from "playwright";

const OUT = process.env.SHOT_DIR ?? ".";
const browser = await chromium.launch({ channel: "chromium" });

const SETTLED =
  "text=/Released by guardrail|Explanation withheld|Cannot answer|Outside scope|ONE MORE THING|CANNOT REACH THE API/";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function ask(page, q) {
  await page.locator("textarea").fill(q);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.waitForSelector(SETTLED, { timeout: 150000 });
  await page.waitForTimeout(600);
}

// ---------------------------------------------------------------- desktop
{
  const desk = await browser.newContext({ viewport: { width: 1560, height: 1100 } });
  // Past the sign-in screen as a guest.
  await desk.addCookies([{ name: "citetax_guest", value: "1", url: "http://localhost:3000" }]);
  const page = await desk.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  console.log("\n=== BUG 1: New question resets the view ===");
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await ask(page, "What is the personal relief for 2026/2027?");
  check("an answer is on screen", (await page.locator(SETTLED).count()) > 0);

  await page.locator("aside >> text=+ New chat").click();
  await page.waitForTimeout(700);
  const backToComposer = await page.locator("text=What would you like checked?").count();
  check("New question returns to the composer", backToComposer > 0);
  check("the answer is gone", (await page.locator(SETTLED).count()) === 0);
  await page.screenshot({ path: `${OUT}\\c1-after-new-question.png` });

  console.log("\n=== BUG 2: prose answers span the full column ===");
  await ask(page, "How does APIT work for a salaried employee?");
  const proseBox = await page.locator("p:has-text('APIT')").first().boundingBox();
  const mainBox = await page.locator("main").boundingBox();
  const ratio = proseBox && mainBox ? proseBox.width / mainBox.width : 0;
  check("prose is wider than half the main column", ratio > 0.55, `${(ratio * 100).toFixed(0)}%`);
  check("no citations rail on a prose answer",
    (await page.locator("text=CITATIONS ·").count()) === 0);
  await page.screenshot({ path: `${OUT}\\c2-prose-full-width.png`, fullPage: true });

  console.log("\n=== rail still present where a table needs it ===");
  await page.locator("aside >> text=+ New chat").click();
  await page.waitForTimeout(500);
  await ask(page, "What do I owe for 2026/2027 on a salary of LKR 250,000 a month?");
  check("computation keeps the citations rail",
    (await page.locator("text=CITATIONS ·").count()) > 0);
  await page.screenshot({ path: `${OUT}\\c3-compute-with-rail.png`, fullPage: true });

  console.log("\n=== auth pages ===");
  await page.goto("http://localhost:3000/signin", { waitUntil: "networkidle" });
  check("sign in shows Continue with Google",
    (await page.locator("text=Continue with Google").count()) > 0);
  check("sign in offers create one", (await page.locator("text=Create one").count()) > 0);
  await page.screenshot({ path: `${OUT}\\c4-signin.png` });

  await page.goto("http://localhost:3000/signin?mode=signup", { waitUntil: "networkidle" });
  check("signup mode changes the heading",
    (await page.locator("text=Create your account").count()) > 0);
  check("signup offers sign in", (await page.locator("text=Already have an account?").count()) > 0);
  await page.screenshot({ path: `${OUT}\\c5-signup.png` });

  await page.goto("http://localhost:3000/profile", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  check("account page shows the signed out state",
    (await page.locator("text=NOT SIGNED IN").count()) > 0);
  await page.screenshot({ path: `${OUT}\\c6-account.png`, fullPage: true });

  console.log(`\n  console errors (non-401): ${errors.filter((e) => !e.includes("401")).length}`);
  errors.filter((e) => !e.includes("401")).slice(0, 5).forEach((e) => console.log("   !", e.slice(0, 160)));
  await page.close();
}

// ---------------------------------------------------------------- mobile
{
  const ctx = await browser.newContext({ ...devices["iPhone 14"] });
  await ctx.addCookies([{ name: "citetax_guest", value: "1", url: "http://localhost:3000" }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  console.log("\n=== MOBILE 390x844 ===");
  const routes = [
    ["/", "c7-m-ask"],
    ["/compare", "c8-m-compare"],
    ["/deadlines", "c9-m-deadlines"],
    ["/profile", "c10-m-account"],
    ["/signin", "c11-m-signin"],
    ["/welcome", "c12-m-welcome"],
  ];

  for (const [route, name] of routes) {
    await page.goto(`http://localhost:3000${route}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1300);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check(`${route} does not scroll sideways`, overflow <= 1, `${overflow}px`);
    await page.screenshot({ path: `${OUT}\\${name}.png`, fullPage: true });
  }

  console.log("\n=== mobile drawer ===");
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  // A closed drawer is translated off screen, so measure where it actually is
  // rather than asking isVisible, which is true for anything with dimensions.
  const railX = async () => (await page.locator("aside").boundingBox())?.x ?? 0;
  check("rail starts off screen", (await railX()) < 0, `x=${await railX()}`);

  await page.getByLabel("Open menu").click();
  await page.waitForTimeout(400);
  check("menu button slides it in", (await railX()) >= 0, `x=${await railX()}`);
  await page.screenshot({ path: `${OUT}\\c13-m-drawer.png` });

  await page.getByLabel("Close menu").click();
  await page.waitForTimeout(400);
  check("close button slides it out", (await railX()) < 0, `x=${await railX()}`);

  await page.getByLabel("Open menu").click();
  await page.waitForTimeout(400);
  await page.locator("aside >> text=+ New chat").click();
  await page.waitForTimeout(500);
  check("choosing an item closes the drawer", (await railX()) < 0, `x=${await railX()}`);

  console.log("\n=== mobile answer ===");
  await ask(page, "What do I owe for 2026/2027 on a salary of LKR 250,000 a month?");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check("answer does not scroll sideways", overflow <= 1, `${overflow}px`);
  await page.screenshot({ path: `${OUT}\\c14-m-answer.png`, fullPage: true });

  console.log(`\n  mobile page errors: ${errors.length}`);
  await ctx.close();
}

await browser.close();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
