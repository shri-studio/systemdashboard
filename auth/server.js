"use strict";
/*
 * systemdashboard auth gateway — zero dependencies.
 *
 * - login form + HMAC-signed session cookie
 * - after MAX_FAILS failed logins an IP is banned (BAN_HOURS=0 => until unbanned)
 * - whitelisted IPs / CIDRs can never be banned and skip login-count tracking
 * - ban list and whitelist are plain files under /data, re-read every request
 *
 * unban:      remove the entry from data/bans.json     (or: bin/unban <ip>)
 * whitelist:  add a line to data/whitelist.txt         (or: bin/whitelist <ip>)
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const UP        = process.env.UPSTREAM     || "http://web:80";
const DOCKER_SOCK = process.env.DOCKER_SOCK || "/var/run/docker.sock";
const CTL_LAN_ONLY = process.env.CTL_LAN_ONLY !== "0";   // control actions: whitelisted IPs only
const REFRESH_FILE = process.env.REFRESH_FILE || "/www/.refresh";
const USER      = process.env.AUTH_USER    || "admin";
const PASS      = process.env.AUTH_PASS    || "";
const PASS_HASH = process.env.AUTH_PASS_HASH || "";           // sha256 hex, optional
const MAX_FAILS = parseInt(process.env.MAX_FAILS || "3", 10);
const BAN_HOURS = parseFloat(process.env.BAN_HOURS || "0");   // 0 => permanent
const SESSION_HOURS = parseFloat(process.env.SESSION_HOURS || "720");
const TRUST_PROXY   = process.env.TRUST_PROXY !== "0";
const SITE   = process.env.SITE_NAME || "systemdashboard";
const PORT   = parseInt(process.env.PORT || "8080", 10);
const DATA   = process.env.DATA_DIR || "/data";
const SEED_WHITELIST = (process.env.WHITELIST ||
  "127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16").split(",").map(s => s.trim());

const BANS_F  = path.join(DATA, "bans.json");
const WL_F    = path.join(DATA, "whitelist.txt");
const FAILS_F = path.join(DATA, "fails.json");
const SECRET_F = path.join(DATA, "secret");

/* ---------- state files ---------- */
fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(SECRET_F)) fs.writeFileSync(SECRET_F, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
if (!fs.existsSync(BANS_F))  fs.writeFileSync(BANS_F, "{}\n");
if (!fs.existsSync(FAILS_F)) fs.writeFileSync(FAILS_F, "{}\n");
if (!fs.existsSync(WL_F)) {
  fs.writeFileSync(WL_F,
    "# one IP or CIDR per line. edited live, no restart needed.\n" +
    SEED_WHITELIST.join("\n") + "\n");
}
const SECRET = fs.readFileSync(SECRET_F, "utf8").trim();

const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
const writeJSON = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + "\n");
const readWL = () => { try {
  return fs.readFileSync(WL_F, "utf8").split("\n")
    .map(l => l.trim()).filter(l => l && !l.startsWith("#"));
} catch { return []; } };

/* ---------- html escaping (for the few spots that echo external strings) ---------- */
const escHtml = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/* ---------- ip helpers ---------- */
// only accept something that actually looks like an IP; anything else (e.g. a
// spoofed header with markup) collapses to null — not a trackable identity.
const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;
function safeIp(ip) {
  ip = (ip || "").replace(/^::ffff:/, "").trim();
  return IP_RE.test(ip) ? ip : null;
}
function clientIp(req) {
  // proxy headers are forgeable — only honour them when we sit behind a trusted
  // proxy / tunnel (TRUST_PROXY). Otherwise the socket peer is the only truth.
  if (TRUST_PROXY) {
    const cf = req.headers["cf-connecting-ip"];
    if (cf) return safeIp(cf);
    const xff = req.headers["x-forwarded-for"];
    if (xff) return safeIp(String(xff).split(",")[0]);
  }
  return safeIp(req.socket.remoteAddress);
}
function v4ToInt(ip) {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  return ((+p[0] << 24) >>> 0) + (+p[1] << 16) + (+p[2] << 8) + (+p[3]);
}
function inCidr(ip, cidr) {
  if (!cidr.includes("/")) return ip === cidr;
  const [net, bitsStr] = cidr.split("/");
  const a = v4ToInt(ip), b = v4ToInt(net), bits = parseInt(bitsStr, 10);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}
function whitelisted(ip) { return !!ip && readWL().some(e => inCidr(ip, e)); }

/* ---------- ban / fail tracking ----------
   ip is null when the address didn't parse (only possible from a forged proxy
   header). Such a request has no trackable identity, so it is never banned and
   never recorded — otherwise every unparseable client would share one bucket
   and could lock each other out. */
function banInfo(ip) {
  if (!ip) return null;
  const bans = readJSON(BANS_F);
  const b = bans[ip];
  if (!b) return null;
  if (b.until && Date.now() > b.until) { delete bans[ip]; writeJSON(BANS_F, bans); return null; }
  return b;
}
function recordFail(ip) {
  if (!ip) return { banned: false, remaining: MAX_FAILS };
  const fails = readJSON(FAILS_F);
  const n = (fails[ip]?.n || 0) + 1;
  fails[ip] = { n, last: Date.now() };
  writeJSON(FAILS_F, fails);
  if (n >= MAX_FAILS) {
    const bans = readJSON(BANS_F);
    bans[ip] = { at: Date.now(), until: BAN_HOURS > 0 ? Date.now() + BAN_HOURS * 3600e3 : 0, fails: n };
    writeJSON(BANS_F, bans);
    delete fails[ip]; writeJSON(FAILS_F, fails);
    return { banned: true, remaining: 0 };
  }
  return { banned: false, remaining: MAX_FAILS - n };
}
function clearFails(ip) {
  if (!ip) return;
  const fails = readJSON(FAILS_F);
  if (fails[ip]) { delete fails[ip]; writeJSON(FAILS_F, fails); }
}

/* ---------- constant-time compare ---------- */
const sha256 = (s) => crypto.createHash("sha256").update(s || "").digest();
// compare via fixed-size digests: constant-time AND immune to the length-mismatch
// throw that would otherwise crash the process on a malformed input.
function eq(a, b) { return crypto.timingSafeEqual(sha256(a), sha256(b)); }

/* ---------- session cookie ---------- */
function sign(data) { return crypto.createHmac("sha256", SECRET).update(data).digest("base64url"); }
function makeCookie() {
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  const payload = Buffer.from(JSON.stringify({ u: USER, exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function validCookie(c) {
  if (!c) return false;
  const [payload, mac] = c.split(".");
  if (!payload || !mac || !eq(mac, sign(payload))) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now(); }
  catch { return false; }
}
function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/* ---------- password check ---------- */
function checkPass(u, p) {
  const passOk = PASS_HASH
    ? eq(sha256(p || ""), Buffer.from(PASS_HASH, "hex"))
    : eq(p, PASS);
  return eq(u, USER) && passOk;
}

/* ---------- pages ---------- */
const SHELL = (title, inner) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{color-scheme:dark}
*{margin:0;padding:0;box-sizing:border-box}
body{background:#090c11;color:#c3cddb;font-family:ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace;
  font-size:13.5px;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  -webkit-font-smoothing:antialiased}
.box{border:1px solid #2b3440;background:#0e131b;max-width:380px;width:100%}
.box h1{font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:#8f9bad;
  padding:12px 16px;border-bottom:1px solid #2b3440}
.box .body{padding:18px 16px}
label{display:block;color:#8f9bad;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;margin:10px 0 4px}
input{width:100%;background:#090c11;border:1px solid #2b3440;color:#f2f5f9;font-family:inherit;
  font-size:13.5px;padding:8px 10px}
input:focus{outline:none;border-color:#7db2ff}
button{margin-top:16px;width:100%;background:#090c11;border:1px solid #3a6ea5;color:#7db2ff;
  font-family:inherit;font-size:13.5px;padding:9px;cursor:pointer}
button:hover{border-color:#7db2ff}
.msg{margin-top:12px;font-size:12.5px}
.err{color:#f57b72}.warn{color:#ecc05a}.ok{color:#74dd92}
.foot{color:#8f9bad;font-size:11.5px;padding:10px 16px;border-top:1px solid #2b3440}
</style></head><body><div class="box">${inner}</div></body></html>`;

const loginPage = (msg) => SHELL(SITE + " · login", `
  <h1>${SITE} · authentication required</h1>
  <form class="body" method="POST" action="/__auth/login">
    <label>username</label><input name="username" autocomplete="username" autofocus>
    <label>password</label><input name="password" type="password" autocomplete="current-password">
    <button type="submit">login</button>
    ${msg ? `<div class="msg ${msg.cls}">${msg.text}</div>` : ""}
  </form>
  <div class="foot">failed attempts are rate-limited; ${MAX_FAILS} failures block this IP</div>`);

const bannedPage = (ip, b) => SHELL(SITE + " · blocked", `
  <h1>${SITE} · access blocked</h1>
  <div class="body">
    <div class="msg err">This IP address (${escHtml(ip)}) is blocked after repeated failed logins.</div>
    <div class="msg" style="color:#5a6675;margin-top:10px">
      ${b.until ? "Automatically clears " + new Date(b.until).toISOString().replace("T", " ").slice(0, 16) + " UTC."
                : "Blocked until an administrator removes it."}
    </div>
  </div>
  <div class="foot">admin: <code>bin/unban ${escHtml(ip)}</code></div>`);

/* ---------- proxy ---------- */
function proxy(req, res) {
  const u = new URL(req.url, UP);
  const opts = {
    protocol: u.protocol, hostname: u.hostname, port: u.port || 80,
    method: req.method, path: u.pathname + u.search,
    headers: { ...req.headers, host: u.host },
  };
  const p = http.request(opts, (pr) => {
    res.writeHead(pr.statusCode, pr.headers);
    pr.pipe(res);
  });
  p.on("error", () => { res.writeHead(502, { "content-type": "text/plain" }); res.end("upstream unavailable"); });
  req.pipe(p);
}

/* ---------- request handler ---------- */
function readBodyN(req, max) {
  return new Promise((resolve) => {
    let d = "";
    const done = () => resolve(d);   // resolve is idempotent; "close" covers destroy()/error
    req.on("data", c => { d += c; if (Buffer.byteLength(d) > max) req.destroy(); });
    req.on("end", done);
    req.on("close", done);
  });
}
const readBody = (req) => readBodyN(req, 1e4);

/* ---------- docker api (unix socket) ---------- */
function dockerApi(method, path) {
  return new Promise((resolve) => {
    const r = http.request({ socketPath: DOCKER_SOCK, method, path, timeout: 15000 }, (pr) => {
      const chunks = [];
      let n = 0;
      pr.on("data", c => { n += c.length; if (n <= 524288) chunks.push(c); });
      pr.on("end", () => resolve({ status: pr.statusCode, buf: Buffer.concat(chunks) }));
    });
    r.on("error", (e) => resolve({ status: 502, buf: Buffer.from(String(e)) }));
    r.on("timeout", () => { r.destroy(); resolve({ status: 504, buf: Buffer.from("timeout") }); });
    r.end();
  });
}
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$/;

// docker log stream: 8-byte frame headers [stream,0,0,0,len32be] unless the
// container has a TTY (then it's raw). Detect and de-multiplex.
function demuxLogs(buf) {
  if (buf.length < 8) return buf.toString("utf8");
  const framed = buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!framed) return stripAnsi(buf.toString("utf8"));
  const out = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    if (buf[i] > 2 || buf[i + 1] !== 0 || buf[i + 2] !== 0 || buf[i + 3] !== 0) break;
    const len = buf.readUInt32BE(i + 4);
    out.push(buf.slice(i + 8, i + 8 + len).toString("utf8"));
    i += 8 + len;
  }
  return stripAnsi(out.join(""));
}
// strip CSI / OSC escape sequences so raw logs read cleanly
function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[=>]/g, "");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("request handler error:", err && err.stack || err);
    try {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    } catch (_) { /* response already gone */ }
  });
});

async function handle(req, res) {
  const ip = clientIp(req);
  const wl = whitelisted(ip);

  if (!wl) {
    const b = banInfo(ip);
    if (b) { res.writeHead(403, { "content-type": "text/html" }); return res.end(bannedPage(ip, b)); }
  }

  // health check, no auth
  if (req.url === "/__auth/health") { res.writeHead(200); return res.end("ok"); }

  if (req.method === "POST" && req.url === "/__auth/login") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const ok = checkPass(params.get("username") || "", params.get("password") || "");
    if (ok) {
      clearFails(ip);
      res.writeHead(302, {
        "set-cookie": `sd_session=${makeCookie()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
        location: "/",
      });
      return res.end();
    }
    await new Promise(r => setTimeout(r, 800)); // slow brute force
    let msg = { cls: "err", text: "invalid credentials" };
    if (!wl) {
      const r = recordFail(ip);
      if (r.banned) { res.writeHead(403, { "content-type": "text/html" }); return res.end(bannedPage(ip, banInfo(ip) || {})); }
      msg = { cls: "warn", text: `invalid credentials — ${r.remaining} attempt${r.remaining === 1 ? "" : "s"} left before this IP is blocked` };
    }
    res.writeHead(401, { "content-type": "text/html" });
    return res.end(loginPage(msg));
  }

  if (req.url === "/__auth/logout") {
    res.writeHead(302, { "set-cookie": "sd_session=; Path=/; Max-Age=0", location: "/" });
    return res.end();
  }

  const authed = validCookie(getCookie(req, "sd_session"));

  // ---- control endpoints (require a session; restart also requires LAN) ----
  if (req.url && req.url.startsWith("/__ctl/")) {
    if (!authed) { res.writeHead(401, { "content-type": "text/plain" }); return res.end("login required"); }
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

    // ask the agent to sample now — harmless, any authed user
    if (req.method === "POST" && req.url === "/__ctl/refresh") {
      try { fs.writeFileSync(REFRESH_FILE, String(Date.now())); } catch (e) {}
      return json(200, { ok: true });
    }

    // does this client get container controls?
    if (req.url === "/__ctl/whoami") {
      return json(200, { ip, lan: wl, controls: (!CTL_LAN_ONLY || wl) });
    }

    // persist the dashboard config (title, favicon, panels, weather, clocks…)
    // any authed user; size-capped; favicon must be a data:image URI
    if (req.method === "POST" && req.url === "/__ctl/config") {
      const body = await readBodyN(req, 512 * 1024);
      let obj;
      try { obj = JSON.parse(body); } catch { return json(400, { error: "invalid json" }); }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return json(400, { error: "not an object" });
      if (obj.favicon && !/^data:image\/[a-z.+-]+;base64,[A-Za-z0-9+/=]+$/.test(obj.favicon))
        return json(400, { error: "favicon must be a base64 data:image URI" });
      if (obj.portainerUrl && !/^https?:\/\/[^\s"'<>]+$/i.test(obj.portainerUrl))
        return json(400, { error: "portainerUrl must be an http(s) URL" });
      try {
        const dst = process.env.CONFIG_FILE || "/www/config.json";
        fs.writeFileSync(dst + ".tmp", JSON.stringify(obj, null, 2) + "\n");
        fs.renameSync(dst + ".tmp", dst);
        return json(200, { ok: true });
      } catch (e) { return json(500, { error: String(e) }); }
    }

    // container lifecycle — whitelisted (LAN) only by default
    const m = req.url.match(/^\/__ctl\/container\/([^/]+)\/(restart|start|stop|logs)$/);
    if (m) {
      if (CTL_LAN_ONLY && !wl) return json(403, { error: "container controls are LAN-only" });
      const name = decodeURIComponent(m[1]), action = m[2];
      if (!SAFE_NAME.test(name)) return json(400, { error: "bad name" });
      if (action === "logs") {
        const r = await dockerApi("GET",
          `/containers/${name}/logs?stdout=1&stderr=1&tail=200&timestamps=0`);
        res.writeHead(r.status === 200 ? 200 : r.status, {
          "content-type": "text/plain; charset=utf-8", "cache-control": "no-store",
        });
        return res.end(r.status === 200 ? (demuxLogs(r.buf) || "(no output)")
                                        : r.buf.toString("utf8"));
      }
      if (req.method !== "POST") return json(405, { error: "POST only" });
      const r = await dockerApi("POST", `/containers/${name}/${action}?t=10`);
      return json(r.status < 300 ? 200 : r.status,
        r.status < 300 ? { ok: true, action, name }
                       : { error: r.buf.toString("utf8") || `docker ${r.status}` });
    }
    return json(404, { error: "unknown control" });
  }

  if (authed) return proxy(req, res);

  res.writeHead(200, { "content-type": "text/html" });
  res.end(loginPage(null));
}

// a gateway should stay up: log and keep serving rather than exit on a stray throw
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e && e.stack || e));
process.on("uncaughtException",  (e) => console.error("uncaughtException:",  e && e.stack || e));

server.listen(PORT, () => {
  console.log(`auth gateway on :${PORT} -> ${UP}  user=${USER}  max_fails=${MAX_FAILS}  ` +
    `ban=${BAN_HOURS > 0 ? BAN_HOURS + "h" : "permanent"}  trust_proxy=${TRUST_PROXY}  ` +
    `container-controls=${CTL_LAN_ONLY ? "LAN only" : "any authed"}`);
});
