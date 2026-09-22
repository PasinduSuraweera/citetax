/**
 * Conversation flow drive: persistent chats end to end, against the running
 * web app (:3000) and API (:8000), with the real model. Costs a few Groq calls.
 *
 *   node scripts-conversations.mjs
 *
 * Signs in without Google by minting a NextAuth session cookie with the
 * AUTH_SECRET from .env.local, for two throwaway accounts
 * (e2e-conv-*@example.invalid). Deletes the chats it made through the API when
 * it finishes; the accounts and their runs stay, as runs always do, and are
 * printed so they can be removed from a shared database.
 *
 * Env: BASE (default http://localhost:3000), PW_CHANNEL (default "chrome"),
 * SHOT_DIR for screenshots.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { encode } from "next-auth/jwt";

const BASE = process.env.BASE ?? "http://localhost:3000";
const OUT = process.env.SHOT_DIR ?? ".";
const COOKIE = "authjs.session-token";

const secret = (() => {
  const env = readFileSync(new URL("./.env.local", import.meta.url), "utf8");
  const line = env.split(/\r?\n/).find((l) => l.startsWith("AUTH_SECRET="));
  if (!line) throw new Error("AUTH_SECRET missing from .env.local");
  return line.slice("AUTH_SECRET=".length).replace(/^["']|["']$/g, "");
})();

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const run = Math.random().toString(16).slice(2, 10);
const A = `e2e-conv-a-${run}@example.invalid`;
const B = `e2e-conv-b-${run}@example.invalid`;

async function signedIn(browser, email, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const value = await encode({
    token: { email, name: `E2E ${email.slice(9, 10).toUpperCase()}`, sub: email },
    secret,
    salt: COOKIE,
    maxAge: 60 * 60,
  });
  await ctx.addCookies([{ name: COOKIE, value, url: BASE, httpOnly: true, sameSite: "Lax" }]);
  return ctx;
}

function watchErrors(page, errors) {
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
}

const recent = (page) => page.locator('aside [aria-label="Recent chats"] li a');
const turns = (page) => page.locator('main ol[aria-label="Conversation"] > li');
const composer = (page) => page.locator('textarea[aria-label="Your question"]');
const idFromUrl = (page) => new URL(page.url()).searchParams.get("c");

async function ask(page, question) {
  await composer(page).fill(question);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.waitForSelector("#pending-turn", { timeout: 15000 });
  await page.waitForSelector("#pending-turn", { state: "detached", timeout: 180000 });
  await page.waitForTimeout(500);
}

async function lastTurnText(page) {
  return (await turns(page).last().innerText()).replace(/\s+/g, " ");
}

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome" });
const errors = [];
const made = [];

// ---------------------------------------------------------------- user A
const ctxA = await signedIn(browser, A);
const page = await ctxA.newPage();
watchErrors(page, errors);

console.log("\n=== first question creates a chat ===");
await page.goto(BASE, { waitUntil: "networkidle" });
check("Recent is shown and empty for a new account",
  (await page.locator("text=No chats yet").count()) === 1);
check("+ New chat is in the rail", (await page.locator("aside >> text=+ New chat").count()) > 0);

await ask(page, "How much tax do I pay on LKR 5 million?");
const first = idFromUrl(page);
made.push(first);
check("URL carries the conversation id", /^[0-9a-f-]{36}$/.test(first ?? ""), page.url());
await page.waitForTimeout(300);
check("the chat is in Recent", (await recent(page).count()) === 1);
const firstTitle = (await recent(page).first().innerText()).trim();
check("title names the question, not the amount", !/\d{3}|million/i.test(firstTitle.replace(/20\d\d\/\d\d/g, "")), firstTitle);
check("the chat is highlighted",
  (await page.locator('aside [aria-label="Recent chats"] a[aria-current="page"]').count()) === 1);
console.log(`     first turn: ${(await lastTurnText(page)).slice(0, 160)}`);
await page.screenshot({ path: path.join(OUT, "conv-1-first.png") });

console.log("\n=== follow-ups carry context ===");
await ask(page, "What if I also earn LKR 500,000 from freelance work?");
check("still the same chat", idFromUrl(page) === first);
const second = await lastTurnText(page);
console.log(`     second turn: ${second.slice(0, 200)}`);
check("follow-up assessed salary plus freelance (assessable 5,500,000)",
  second.includes("5,500,000"), second.includes("ONE MORE THING") ? "asked to clarify" : "");
check("the earlier turn is collapsed", (await page.locator("text=Show ▾").count()) === 1);

await ask(page, "What about EPF?");
const third = await lastTurnText(page);
console.log(`     third turn: ${third.slice(0, 200)}`);
check("third turn answered in the same chat", idFromUrl(page) === first);
check("two earlier turns collapsed", (await page.locator("text=Show ▾").count()) === 2);
await page.screenshot({ path: path.join(OUT, "conv-2-thread.png"), fullPage: true });

console.log("\n=== refresh restores the thread ===");
await page.reload({ waitUntil: "networkidle" });
await turns(page).first().waitFor();
check("three turns after reload", (await turns(page).count()) === 3);
check("latest expanded, earlier collapsed", (await page.locator("text=Show ▾").count()) === 2);
check("snapshot stamp shown", (await page.locator("text=/Answered at snapshot/").count()) >= 1);

console.log("\n=== expanding an older turn shows the stored answer ===");
await page.locator("text=Show ▾").first().click();
await page.waitForTimeout(400);
check("older turn expanded", (await page.locator("text=Show ▾").count()) === 1);
await page.locator("text=Collapse ▴").first().click();
check("and collapsed again", (await page.locator("text=Show ▾").count()) === 2);

console.log("\n=== + New chat is independent ===");
await page.locator("aside >> text=+ New chat").click();
await page.waitForURL((u) => !u.searchParams.get("c"));
await page.waitForSelector("text=What would you like checked?");
check("empty draft on screen", (await turns(page).count()) === 0);
check("the old chat is still in Recent", (await recent(page).count()) === 1);

await ask(page, "When is my return due for 2025/2026?");
const secondChat = idFromUrl(page);
made.push(secondChat);
check("a second, different chat", secondChat && secondChat !== first);
check("both chats listed, newest first",
  (await recent(page).count()) === 2 &&
  (await recent(page).first().getAttribute("href")) === `/?c=${secondChat}`);

console.log("\n=== switching chats ===");
await recent(page).nth(1).click();
await page.waitForURL((u) => u.searchParams.get("c") === first);
await turns(page).first().waitFor();
check("first chat restored with its three turns", (await turns(page).count()) === 3);
await recent(page).first().click();
await page.waitForURL((u) => u.searchParams.get("c") === secondChat);
await turns(page).first().waitFor();
await page.waitForTimeout(300);
check("second chat shows its one turn", (await turns(page).count()) === 1);

console.log("\n=== rename from the sidebar ===");
await page.getByRole("button", { name: `Options for ${firstTitle}` }).click();
await page.locator("aside").getByRole("button", { name: "Rename", exact: true }).click();
await page.locator('aside input[aria-label="Chat title"]').fill("Salary and freelance");
await page.keyboard.press("Enter");
await page.waitForTimeout(800);
check("renamed in Recent", (await page.locator("aside >> text=Salary and freelance").count()) === 1);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(600);
check("rename survives a reload", (await page.locator("aside >> text=Salary and freelance").count()) === 1);
check("renaming did not reorder Recent",
  (await recent(page).first().getAttribute("href")) === `/?c=${secondChat}`);

console.log("\n=== the same account on another device ===");
const ctxA2 = await signedIn(browser, A);
const other = await ctxA2.newPage();
watchErrors(other, errors);
await other.goto(`${BASE}/?c=${first}`, { waitUntil: "networkidle" });
await turns(other).first().waitFor();
check("same three turns on a fresh browser", (await turns(other).count()) === 3);
check("same renamed title", (await other.locator("main h1").innerText()).includes("Salary and freelance"));
await ctxA2.close();

// ---------------------------------------------------------------- user B
console.log("\n=== another account cannot open it ===");
const ctxB = await signedIn(browser, B);
const pb = await ctxB.newPage();
// B is meant to get a 404 for A's chat, and Chrome logs every failed request
// as a console error. That one is expected; anything else still counts.
const errorsB = [];
watchErrors(pb, errorsB);
await pb.goto(`${BASE}/?c=${first}`, { waitUntil: "networkidle" });
await pb.waitForTimeout(800);
check("B sees chat not found", (await pb.locator("text=CHAT NOT FOUND").count()) === 1);
check("B's Recent is empty", (await pb.locator("text=No chats yet").count()) === 1);
check("none of A's text leaks", (await pb.locator("text=Salary and freelance").count()) === 0);
errors.push(...errorsB.filter((e) => !/status of 404/.test(e)));
await ctxB.close();

// ---------------------------------------------------------------- anonymous
console.log("\n=== signed out ===");
const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const pa = await anon.newPage();
watchErrors(pa, errors);
await pa.goto(BASE, { waitUntil: "networkidle" });
check("no Recent section signed out", (await pa.locator('[aria-label="Recent chats"]').count()) === 0);
await pa.goto(`${BASE}/?c=${first}`, { waitUntil: "networkidle" });
await pa.waitForTimeout(500);
check("a chat link asks to sign in", (await pa.locator("text=SIGN IN TO OPEN THIS CHAT").count()) === 1);
await anon.close();

// ---------------------------------------------------------------- phone
console.log("\n=== phone: Recent in the drawer ===");
const ctxP = await signedIn(browser, A, { width: 390, height: 844 });
const pp = await ctxP.newPage();
watchErrors(pp, errors);
await pp.goto(BASE, { waitUntil: "networkidle" });
await pp.getByRole("button", { name: "Open menu" }).click();
await pp.waitForTimeout(400);
check("Recent visible in the drawer", await recent(pp).first().isVisible());
await recent(pp).nth(1).click();
await pp.waitForURL((u) => u.searchParams.get("c") === first);
await pp.waitForTimeout(800);
check("drawer closed after choosing a chat",
  (await pp.getByRole("button", { name: "Open menu" }).getAttribute("aria-expanded")) === "false");
check("thread renders on a phone", (await turns(pp).count()) === 3);
const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check("no horizontal overflow on a phone", overflow <= 1, `${overflow}px`);
await pp.screenshot({ path: path.join(OUT, "conv-3-phone.png") });
await ctxP.close();

// ---------------------------------------------------------------- delete
console.log("\n=== delete from the thread header ===");
await page.goto(`${BASE}/?c=${secondChat}`, { waitUntil: "networkidle" });
await page.waitForSelector("main h1");
await page.locator("main").getByRole("button", { name: "Delete", exact: true }).click();
await page.locator("main").getByRole("button", { name: "Delete", exact: true }).click();
await page.waitForURL((u) => !u.searchParams.get("c"));
await page.waitForTimeout(600);
check("back to a new chat", (await page.locator("main h1", { hasText: "What would you like checked?" }).count()) === 1);
check("deleted chat gone from Recent", (await recent(page).count()) === 1);
made.splice(made.indexOf(secondChat), 1);

// ---------------------------------------------------------------- tidy
const token = await page.evaluate(async () => (await (await fetch("/api/token")).json()).token);
for (const id of made) {
  await page.evaluate(async ([id, t]) => {
    await fetch(`http://127.0.0.1:8000/v1/conversations/${id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${t}` },
    });
  }, [id, token]);
}
await browser.close();

const real = errors.filter((e) => !/Download the React DevTools|\[HMR\]|\[Fast Refresh\]/.test(e));
check("no page errors", real.length === 0, real.slice(0, 3).join(" | "));
console.log(`\nTest accounts: ${A}, ${B}`);
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
