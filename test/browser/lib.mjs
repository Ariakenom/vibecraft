// Shared by the browser tests: a headless Chromium page on the local copy.
// See run.sh. three.js comes from a local file (THREE_JS), since the tests
// shouldn't depend on the CDN.
import { chromium } from "playwright";
import fs from "fs";
const THREE = fs.readFileSync(process.env.THREE_JS || new URL("./three.min.js", import.meta.url));
export const URL0 = "http://localhost:8080/vibecraft/";
// Software WebGL: correct, but slow, so the tests turn drawing off.
export async function browser() {
  return chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
}
export async function open(b, hash = "", { draw = false, w = 1280, h = 800 } = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", e => { page.errors.push(String(e)); console.log("PAGE ERROR", e.message); });
  page.on("console", m => { if (m.type() === "error") { page.errors.push(m.text()); console.log("console error:", m.text()); } });
  await page.route("https://cdn.jsdelivr.net/**", r => r.fulfill({ body: THREE, contentType: "text/javascript" }));
  await page.route("https://fonts.googleapis.com/**", r => r.fulfill({ body: "", contentType: "text/css" }));
  await page.goto(URL0 + hash);
  await page.waitForFunction(() => typeof W !== "undefined" && typeof R3 !== "undefined" && R3.renderer);
  if (!draw) await page.evaluate(() => { window.render3d = () => {}; });
  return page;
}
let fails = 0;
export const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };
export const failed = () => fails;
export const sleep = ms => new Promise(r => setTimeout(r, ms));
