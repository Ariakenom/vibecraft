"use strict";
// ===========================================================================
// Chat: short messages between everyone in the room (the lobby, then the
// game): players and spectators alike. It has nothing to do with the
// simulation, so it goes straight through the room on its own topic and is
// never part of a replay.
//
// In a game: Enter (or the Chat button) opens the line, Enter sends, Escape
// closes. Recent messages show at the bottom left and fade. In the lobby
// there's a small box under the seats.
//
// Message (topic "chat"): {v, id, token, name, slot, text}. `name` is a
// colour, "Spectator" or "Guest"; `slot` colours it. Over the relay only:
// claude.ai's room keeps just the latest value, which would lose messages.

const CHAT = { MAX: 200, KEEP: 60, SHOW_MS: 12000, GAP_MS: 400 };
const Chat = {
  log: [],            // [{name, slot, text, mine, at}]
  seen: new Set(),    // ids already shown (a message is never shown twice)
  others: 0,          // people in the room besides me
  lastSent: 0,
  open: false,

  // A new room: someone else's people, so a fresh log.
  attach(r) {
    this.log = []; this.seen.clear(); this.others = 0;
    r.on("chat", d => this.receive(d));
    this.render();
  },
  // How many others are in the room (from the room's peer lists).
  setOthers(n) { this.others = n; this.sync(); },
  available() { return !!room && !Net.room && this.others > 0; },

  // Who I am, as others see me.
  me() {
    if (watcher || (observe && observe.kind !== "out")) return { name: "Spectator", slot: 0 };
    if (running && ME >= 1) return { name: PNAME[ME], slot: ME };
    // In a lobby: my seat's colour.
    const list = guestOf ? (guestOf.host ? guestOf.host.seats : []) : seats;
    const i = guestOf ? list.indexOf("f:" + myToken) : 0;
    const slot = i >= 0 ? slotOf(i, list) : 0;
    return slot ? { name: PNAME[slot], slot } : { name: "Guest", slot: 0 };
  },
  send(text) {
    text = String(text || "").replace(/\s+/g, " ").trim().slice(0, CHAT.MAX);
    if (!text || !this.available()) return false;
    const now = performance.now();
    if (now - this.lastSent < CHAT.GAP_MS) return false;
    this.lastSent = now;
    const { name, slot } = this.me();
    const id = myToken + ":" + Math.random().toString(36).slice(2, 10);
    room.emit("chat", { v: NET.PROTOCOL, id, token: myToken, name, slot, text });
    this.add({ name, slot, text, mine: true }, id);
    return true;
  },
  receive(d) {
    if (!d || d.v !== NET.PROTOCOL || typeof d.text !== "string" || typeof d.id !== "string" || d.id.length > 40) return;
    const text = d.text.replace(/\s+/g, " ").trim().slice(0, CHAT.MAX);
    if (!text) return;
    const name = PNAME.includes(d.name) && d.name !== "Nature" ? d.name : d.name === "Spectator" ? "Spectator" : "Guest";
    const slot = Number.isInteger(d.slot) && d.slot >= 1 && d.slot <= 4 && PNAME[d.slot] === name ? d.slot : 0;
    if (this.add({ name, slot, text, mine: false }, d.id) && !document.hidden) Sfx.ui("queued");
  },
  add(m, id) {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    m.at = performance.now();
    this.log.push(m);
    if (this.log.length > CHAT.KEEP) this.log.shift();
    this.render();
    return true;
  },

  // ---- the page ----
  line(m) {
    const p = document.createElement("p");
    const who = document.createElement("b");
    who.textContent = m.name + ":";
    who.style.color = m.slot ? PLIGHT[m.slot] : "var(--muted)";
    p.append(who, document.createTextNode(" " + m.text)); // text, never HTML
    if (m.mine) p.className = "mine";
    return p;
  },
  render() {
    // In the game: the recent lines (all of them while typing).
    const box = $("chatLog");
    const now = performance.now();
    const recent = this.open ? this.log.slice(-20) : this.log.filter(m => now - m.at < CHAT.SHOW_MS).slice(-6);
    box.replaceChildren(...recent.map(m => this.line(m)));
    box.hidden = !recent.length;
    box.classList.toggle("open", this.open);
    box.scrollTop = box.scrollHeight;
    // In the lobby: the whole log.
    const lobby = $("lobbyChatLog");
    lobby.replaceChildren(...this.log.slice(-30).map(m => this.line(m)));
    lobby.hidden = !this.log.length;
    lobby.scrollTop = lobby.scrollHeight;
  },
  // Show or hide what depends on there being someone to talk to.
  sync() {
    const ok = this.available();
    $("chatBtn").hidden = !ok;
    $("lobbyChat").hidden = !ok;
    if (!ok && this.open) this.close();
  },
  // Once a second: let old lines fade from the game view.
  tick() { if (!this.open && this.log.length) this.render(); },

  show() {
    if (!this.available() || !running) return;
    this.open = true;
    $("chatLine").hidden = false;
    $("chatInput").focus();
    this.render();
  },
  close() {
    this.open = false;
    $("chatLine").hidden = true;
    $("chatInput").value = "";
    $("chatInput").blur();
    this.render();
  },
};

function initChatUi() {
  const input = $("chatInput");
  input.maxLength = CHAT.MAX;
  input.addEventListener("keydown", e => {
    e.stopPropagation(); // typing isn't hotkeys
    if (e.key === "Enter") { Chat.send(input.value); Chat.close(); }
    else if (e.key === "Escape") Chat.close();
  });
  input.addEventListener("keyup", e => e.stopPropagation());
  input.addEventListener("blur", () => { if (Chat.open) setTimeout(() => { if (document.activeElement !== input) Chat.close(); }, 0); });
  $("chatBtn").onclick = () => (Chat.open ? Chat.close() : Chat.show());
  const lobbyInput = $("lobbyChatInput");
  lobbyInput.maxLength = CHAT.MAX;
  const sendLobby = () => { if (Chat.send(lobbyInput.value)) lobbyInput.value = ""; };
  lobbyInput.addEventListener("keydown", e => { if (e.key === "Enter") sendLobby(); });
  $("lobbyChatSend").onclick = sendLobby;
  setInterval(() => Chat.tick(), 1000);
}
