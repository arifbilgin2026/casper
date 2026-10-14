/* söyle — the server. One process, three jobs:
 *
 *   - two pages: / is a plain-HTML sign-in gate (form posts, redirects, no
 *     script), /game is the game, handed out only to a signed-in session;
 *   - the auth endpoints behind those forms, plus GET /api/me for the game;
 *   - one authenticated websocket per session, owned by a Game.
 *
 *     python? no — see README. This is the TypeScript implementation; the
 *     original Python prototype lives in the git history.
 *
 *     npm start            →  http://localhost:8600
 */
import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

import {
  checkPassword, clearCookie, cookieValue, hashPassword, makeSession,
  readSession, sessionCookie,
} from "./auth.js";
import { Game } from "./game.js";
import type { Card, Lang } from "./persona.js";
import { makeStore, User } from "./store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8600);
const NO_LLM = process.env.SOYLE_NO_LLM === "1";
const LANGS: Lang[] = ["tr", "ru", "en"];
const VOICES: Record<Lang, string> = {
  tr: "Et3hA9mm8aHhswBL5jmC",
  ru: "GN4wbsbejSnGSa1AzjH5",
  en: "21m00Tcm4TlvDq8ikWAM",
};

interface DeckFile {
  words: Card[];
  phrases: Record<"ask" | "yes" | "again", string[]>;
}
const DECKS = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(
  readFileSync(path.join(HERE, "..", "decks", `words_${l}.json`), "utf8"),
) as DeckFile])) as Record<Lang, DeckFile>;

const store = makeStore();

// ── pages, forms, and the one JSON endpoint the game page reads ──────────

/** The sign-in gate is plain HTML, so its POSTs arrive form-encoded. */
function form(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((ok) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 4096) req.destroy(); });
    req.on("end", () => ok(Object.fromEntries(new URLSearchParams(data))));
  });
}

function page(res: ServerResponse, file: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8",
                       "cache-control": "no-store" });
  res.end(readFileSync(path.join(HERE, "..", "web", file)));
}

function redirect(res: ServerResponse, to: string, cookie?: string): void {
  const headers: Record<string, string> = { location: to };
  if (cookie) headers["set-cookie"] = cookie;
  res.writeHead(302, headers);
  res.end();
}

function oops(res: ServerResponse, msg: string): void {
  redirect(res, "/?error=" + encodeURIComponent(msg));
}

async function me(req: IncomingMessage): Promise<User | null> {
  const email = readSession(cookieValue(req.headers.cookie, "sid"));
  return email ? store.get(email) : null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/health") { res.writeHead(200); res.end("ok\n"); return; }

    // The two pages. A session sees the game; a stranger sees the gate.
    if (url.pathname === "/" && req.method === "GET") {
      return await me(req) ? redirect(res, "/game") : page(res, "login.html");
    }
    if (url.pathname === "/game" && req.method === "GET") {
      return await me(req) ? page(res, "game.html") : redirect(res, "/");
    }
    if ((url.pathname === "/app.js" || url.pathname === "/mic-worklet.js")
        && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8",
                           "cache-control": "no-store" });
      res.end(readFileSync(path.join(HERE, "..", "web", url.pathname.slice(1))));
      return;
    }

    if (url.pathname === "/signup" && req.method === "POST") {
      const b = await form(req);
      const email = (b.email ?? "").trim().toLowerCase();
      const lang = LANGS.includes(b.lang as Lang) ? (b.lang as Lang) : "tr";
      if (!/^\S+@\S+\.\S+$/.test(email)) return oops(res, "that email looks off");
      if ((b.password ?? "").length < 6) return oops(res, "password needs 6 characters");
      const user: User = {
        email, pw: hashPassword(b.password!),
        childName: (b.childName ?? "").trim() || "kiddo",
        lang, stars: 0, mastered: [], createdAt: new Date().toISOString(),
      };
      if (!await store.create(user)) return oops(res, "that account already exists — sign in above");
      return redirect(res, "/game", sessionCookie(makeSession(email)));
    }

    if (url.pathname === "/login" && req.method === "POST") {
      const b = await form(req);
      const email = (b.email ?? "").trim().toLowerCase();
      const user = await store.get(email);
      if (!user || !checkPassword(b.password ?? "", user.pw)) {
        return oops(res, "wrong email or password");
      }
      return redirect(res, "/game", sessionCookie(makeSession(email)));
    }

    if (url.pathname === "/logout" && req.method === "POST") {
      return redirect(res, "/", clearCookie());
    }

    // The game page fetches this once, for the family's language and stars.
    if (url.pathname === "/api/me" && req.method === "GET") {
      const user = await me(req);
      if (!user) { res.writeHead(401); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ email: user.email, childName: user.childName,
        lang: user.lang, stars: user.stars, mastered: user.mastered.length }));
      return;
    }

    res.writeHead(404); res.end();
  } catch (e) {
    console.log("http error:", e);
    if (!res.headersSent) { res.writeHead(500); res.end(); }
  }
});

// ── the game socket: one per child, refused without a session ────────────

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  const email = readSession(cookieValue(req.headers.cookie, "sid"));
  const user = email ? await store.get(email) : null;
  if (!user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => { void session(ws, req, user); });
});

async function session(ws: WebSocket, req: IncomingMessage, user: User): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const lang = (LANGS.includes(url.searchParams.get("lang") as Lang)
    ? url.searchParams.get("lang") : user.lang) as Lang;
  const deck = DECKS[lang];
  const game = new Game(lang, deck.words, deck.phrases, VOICES[lang], {
    sendJson: (o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); },
    sendPcm: (b) => { if (ws.readyState === WebSocket.OPEN) ws.send(b); },
    onStar: (word) => { void store.addStar(user.email, word); },
    log: (line) => console.log(`[${user.email}] ${line}`),
  }, { noLlm: NO_LLM, startScore: user.stars });

  try {
    await game.start();
  } catch (e) {
    console.log("session start failed:", e);
    ws.close(1011, "voice backend unavailable");
    return;
  }
  ws.on("message", (data, isBinary) => {
    if (isBinary) game.feed(Buffer.from(data as Buffer));
    else if (String(data) === "next") game.next();
  });
  ws.on("close", () => game.close());
}

server.listen(PORT, () => {
  console.log(`söyle → http://localhost:${PORT}           (profile language)`);
  console.log(`       → /?lang=tr | /?lang=ru | /?lang=en  (override)`);
  if (NO_LLM) console.log("       model disabled (SOYLE_NO_LLM=1): canned lines only");
});
