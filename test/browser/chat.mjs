// Chat: in the lobby, then in the game, between players and a spectator.
// Typing must not trigger hotkeys, and text is shown as text, never HTML.
import { browser, open, check, failed, sleep } from "./lib.mjs";
const b = await browser();
const host = await open(b);
await host.waitForFunction(() => roomCode && room);
const code = await host.evaluate(() => roomCode);
check(await host.evaluate(() => $("lobbyChat").hidden), "alone in the lobby: no chat box");
const guest = await open(b, "#" + code);
// Nobody picked a name: everyone has a random one from history.
const gname = await guest.evaluate(() => myName);
check(await host.evaluate(() => RANDOM_NAMES.includes(myName)) && await guest.evaluate(() => RANDOM_NAMES.includes(myName)), `no name picked: a random one (${gname})`);
await host.waitForSelector("#lobbyChat:not([hidden])", { timeout: 15000 });
await guest.waitForSelector("#lobbyChat:not([hidden])", { timeout: 15000 });
check(true, "a friend arrives: both get the chat box");
await guest.fill("#lobbyChatInput", "hi, ready when you are");
await guest.press("#lobbyChatInput", "Enter");
await host.waitForFunction(() => /ready when you are/.test($("lobbyChatLog").textContent), null, { timeout: 5000 });
check(await host.evaluate(n => $("lobbyChatLog").textContent.startsWith(n + ": hi, ready"), gname), `lobby: the host sees "${gname}: hi, ready when you are"`);
check(await guest.evaluate(() => $("lobbyChatInput").value === "" && /hi, ready/.test($("lobbyChatLog").textContent)), "the sender sees their own line, and the box is cleared");

await host.evaluate(() => beginGame());
await guest.waitForFunction(() => running && mp, null, { timeout: 15000 });
// In the game: Enter opens the line; typing "q" there must not start building a farm.
await guest.evaluate(() => { readWorld(); const ids = []; for (let i = 0; i < entCount; i++) if (E(i, F.owner) === ME && E(i, F.kind) === 0) ids.push(E(i, F.id)); setSelection(ids); });
await guest.keyboard.press("Enter");
check(await guest.evaluate(() => Chat.open && document.activeElement === $("chatInput")), "in the game, Enter opens the chat line");
await guest.keyboard.type("q <b>bold</b> & attack");
await guest.keyboard.press("Enter");
check(await guest.evaluate(() => placing === null && !Chat.open), "typing \"q\" didn't start a farm; Enter sent and closed");
await host.waitForFunction(() => /attack/.test($("chatLog").textContent), null, { timeout: 5000 });
check(await host.evaluate(n => $("chatLog").textContent.includes(n + ": q <b>bold</b> & attack") && !$("chatLog").querySelector("p > b + b, p b b"), gname), "the host sees it, as plain text");
// A spectator joins and says something; both players see it.
const w = await open(b, "#watch-" + code);
await w.waitForFunction(() => watcher && watcher.loaded, null, { timeout: 20000 });
const wname = await w.evaluate(() => myName);
await w.waitForSelector("#chatBtn:not([hidden])");
await w.click("#chatBtn");
await w.keyboard.type("nice start");
await w.keyboard.press("Enter");
for (const [pg, n] of [[host, "host"], [guest, "guest"]]) {
  await pg.waitForFunction(m => $("chatLog").textContent.includes(m + ": nice start"), wname, { timeout: 5000 });
  check(true, `${n} sees "${wname}: nice start"`);
}
// Escape closes without sending.
await host.keyboard.press("Enter");
await host.keyboard.type("never mind");
await host.keyboard.press("Escape");
await sleep(800);
check(await guest.evaluate(() => !/never mind/.test($("chatLog").textContent)) && await host.evaluate(() => !Chat.open), "Escape closes the line without sending");
// Old lines fade from the game view.
await host.evaluate(() => { for (const m of Chat.log) m.at -= 20000; Chat.render(); });
check(await host.evaluate(() => $("chatLog").hidden && Chat.log.length === 3), "after a while the lines fade (the log keeps them)");
for (const [pg, n] of [[host, "host"], [guest, "guest"], [w, "spectator"]]) check(pg.errors.length === 0, `no page errors (${n})`);
await b.close();
process.exit(failed() ? 1 : 0);
