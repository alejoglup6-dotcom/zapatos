"use strict";
/* Tienda de zapatos · servidor sin dependencias (solo Node 18+).
   Variables de entorno:
     ADMIN_PASSWORD  contraseña del administrador (obligatoria para editar)
     SESSION_SECRET  texto largo aleatorio para firmar la sesión (recomendado)
     DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME   conexión a MySQL (o bien DATABASE_URL)
     DB_SSL          pon "true" si tu proveedor exige SSL
     PORT            lo pone Render automáticamente                                   */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const fsp = fs.promises;
const mysql = require("mysql2/promise");

const PORT = +process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("tienda:" + ADMIN_PASSWORD).digest("hex");
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_BODY = 30 * 1024 * 1024;
const MAX_PHOTO = 3 * 1024 * 1024;
const CATS = ["Tenis", "Sandalias", "Zapatos", "Botas", "Infantil", "Otros"];
const PARA = ["Mujer", "Hombre", "Niños", "Unisex"];
const UP_RE = /^\/uploads\/[\w-]+\.(jpg|png|webp)$/;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8" };

if (!ADMIN_PASSWORD) console.warn("⚠ Falta ADMIN_PASSWORD: nadie podrá entrar al modo administrador.");

/* ---------- MySQL ---------- */
const dbConfig = process.env.DATABASE_URL
  ? { uri: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST, port: +process.env.DB_PORT || 3306,
      user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    };
const pool = mysql.createPool(Object.assign({
  waitForConnections: true, connectionLimit: 5, charset: "utf8mb4", connectTimeout: 15000,
}, dbConfig, process.env.DB_SSL === "true" ? { ssl: { rejectUnauthorized: false } } : {}));

/* ---------- Validación ---------- */
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const escHtml = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
function int(v, min, max) {
  const n = parseInt(String(v == null ? "" : v).replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}
const httpErr = (status, message) => Object.assign(new Error(message), { status });

function cleanTienda(t) {
  t = t && typeof t === "object" ? t : {};
  return {
    nombre: str(t.nombre, 50) || "Mi tienda de zapatos",
    ciudad: str(t.ciudad, 40),
    whatsapp: str(t.whatsapp, 20).replace(/\D/g, ""),
    direccion: str(t.direccion, 90),
    horario: str(t.horario, 90),
    bienvenida: str(t.bienvenida, 200),
  };
}
const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
function cleanProduct(p) {
  if (!p || typeof p !== "object") return null;
  const nombre = str(p.nombre, 90);
  const precio = int(p.precio, 0, 1e9);
  if (!nombre || precio <= 0) return null;
  let precioAntes = int(p.precioAntes, 0, 1e9);
  if (precioAntes <= precio) precioAntes = 0;
  const tallas = (Array.isArray(p.tallas) ? p.tallas : []).slice(0, 40)
    .map((t) => ({ t: str(t && t.t, 10), u: int(t && t.u, 0, 9999) }))
    .filter((t) => t.t);
  if (!tallas.length) return null;
  const fotos = (Array.isArray(p.fotos) ? p.fotos : []).slice(0, 6)
    .filter((f) => typeof f === "string" && f.length < 6 * 1024 * 1024 && (UP_RE.test(f) || DATA_URL_RE.test(f)));
  const id = /^[\w-]{1,40}$/.test(String(p.id || "")) ? String(p.id) : "p" + crypto.randomBytes(5).toString("hex");
  const out = {
    id, nombre, marca: str(p.marca, 40),
    categoria: CATS.includes(p.categoria) ? p.categoria : "Otros",
    para: PARA.includes(p.para) ? p.para : "Unisex",
    descripcion: str(p.descripcion, 900), precio, precioAntes, tallas, fotos,
    visible: p.visible !== false,
    creado: Number(p.creado) > 0 && Number(p.creado) < 4102444800000 ? Number(p.creado) : 0,
  };
  const i = p.ilu;
  if (i && ["sneaker", "sandal", "loafer"].includes(i.k) && /^#[0-9a-f]{6}$/i.test(i.c) && /^#[0-9a-f]{6}$/i.test(i.s)) out.ilu = { k: i.k, c: i.c, s: i.s };
  return out;
}

/* ---------- Almacenamiento (MySQL) ---------- */
let state = { tienda: cleanTienda({}), productos: [] };

async function initDb() {
  await pool.query("CREATE TABLE IF NOT EXISTS tienda_estado (id TINYINT PRIMARY KEY, datos LONGTEXT NOT NULL, actualizado TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) CHARACTER SET utf8mb4");
  await pool.query("CREATE TABLE IF NOT EXISTS fotos (nombre VARCHAR(64) PRIMARY KEY, tipo VARCHAR(20) NOT NULL, datos LONGBLOB NOT NULL, creada TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
  const [rows] = await pool.query("SELECT datos FROM tienda_estado WHERE id = 1");
  if (rows.length) {
    try {
      const j = JSON.parse(rows[0].datos);
      state = { tienda: cleanTienda(j.tienda), productos: (j.productos || []).map(cleanProduct).filter(Boolean) };
    } catch (e) { console.error("No se pudo leer el estado guardado:", e.message); }
  }
}

let chain = Promise.resolve();
function exclusive(fn) { const r = chain.then(fn); chain = r.catch(() => {}); return r; }

async function saveState() {
  await pool.query("INSERT INTO tienda_estado (id, datos) VALUES (1, ?) ON DUPLICATE KEY UPDATE datos = VALUES(datos)", [JSON.stringify(state)]);
}
function magicOk(b, type) {
  if (type === "jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  return b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP";
}
async function persistPhotos(list) {
  const out = [];
  for (const f of list) {
    if (UP_RE.test(f)) {
      const [r] = await pool.query("SELECT 1 FROM fotos WHERE nombre = ?", [f.slice(9)]);
      if (r.length) out.push(f);
      continue;
    }
    const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(f);
    if (!m) continue;
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > MAX_PHOTO || !magicOk(buf, m[1])) throw httpErr(400, "Una de las fotos no es válida o pesa demasiado.");
    const name = crypto.randomBytes(12).toString("hex") + "." + (m[1] === "jpeg" ? "jpg" : m[1]);
    await pool.query("INSERT INTO fotos (nombre, tipo, datos) VALUES (?, ?, ?)", [name, "image/" + m[1], buf]);
    out.push("/uploads/" + name);
  }
  return out;
}
async function cleanupUploads() {
  const used = [];
  state.productos.forEach((p) => p.fotos.forEach((f) => used.push(path.basename(f))));
  if (!used.length) return void (await pool.query("DELETE FROM fotos"));
  await pool.query("DELETE FROM fotos WHERE nombre NOT IN (?)", [used]);
}

/* ---------- Sesión de administrador ---------- */
const sign = (p) => crypto.createHmac("sha256", SECRET).update(p).digest("hex");
function makeToken() { const exp = String(Date.now() + SESSION_MS); return exp + "." + sign(exp); }
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = String(t).split(".");
  if (!exp || !sig) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b) && +exp > Date.now();
}
function cookies(req) {
  const o = {};
  (req.headers.cookie || "").split(";").forEach((c) => { const i = c.indexOf("="); if (i > 0) { try { o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); } catch (e) {} } });
  return o;
}
const isAdmin = (req) => !!ADMIN_PASSWORD && validToken(cookies(req).sid);
function passOk(p) {
  const a = crypto.createHash("sha256").update(String(p)).digest();
  const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
const fails = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (now - v.t > 15 * 60 * 1000) fails.delete(k); }, 5 * 60 * 1000).unref();
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const isHttps = (req) => req.headers["x-forwarded-proto"] === "https";

/* ---------- HTTP ---------- */
function headers(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
}
function json(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, extra || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers["content-type"] || "");
    if (!ct.includes("application/json")) return reject(httpErr(415, "Formato no admitido."));
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(httpErr(413, "El contenido es demasiado grande.")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(httpErr(400, "JSON inválido.")); } });
    req.on("error", reject);
  });
}
function publicView() { return { tienda: state.tienda, productos: state.productos.filter((p) => p.visible) }; }

async function api(req, res, p) {
  const m = req.method;
  if (m !== "GET") {
    const o = req.headers.origin;
    if (o) { let h = ""; try { h = new URL(o).host; } catch (e) {} if (h !== req.headers.host) throw httpErr(403, "Origen no permitido."); }
  }
  if (p === "/api/store" && m === "GET") return json(res, 200, isAdmin(req) ? state : publicView());
  if (p === "/api/me" && m === "GET") return json(res, 200, { admin: isAdmin(req) });
  if (p === "/api/logout" && m === "POST") {
    return json(res, 200, { ok: true }, { "Set-Cookie": "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + (isHttps(req) ? "; Secure" : "") });
  }
  if (p === "/api/login" && m === "POST") {
    const ip = clientIp(req), f = fails.get(ip) || { n: 0, t: Date.now() };
    if (f.n >= 8 && Date.now() - f.t < 15 * 60 * 1000) throw httpErr(429, "Demasiados intentos.");
    const body = await readBody(req);
    if (!ADMIN_PASSWORD || !passOk(body.password || "")) {
      fails.set(ip, { n: f.n + 1, t: Date.now() });
      throw httpErr(401, "Contraseña incorrecta.");
    }
    fails.delete(ip);
    return json(res, 200, { ok: true }, { "Set-Cookie": "sid=" + encodeURIComponent(makeToken()) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + SESSION_MS / 1000 + (isHttps(req) ? "; Secure" : "") });
  }
  if (p === "/api/store" && m === "PUT") {
    if (!isAdmin(req)) throw httpErr(401, "Tu sesión terminó. Entra de nuevo.");
    const body = await readBody(req);
    const tienda = cleanTienda(body.tienda);
    const raw = Array.isArray(body.productos) ? body.productos.slice(0, 300) : [];
    const prods = raw.map(cleanProduct);
    if (prods.some((x) => !x)) throw httpErr(400, "Revisa los datos de los artículos.");
    if (new Set(prods.map((x) => x.id)).size !== prods.length) throw httpErr(400, "Hay artículos con el mismo identificador.");
    await exclusive(async () => {
      for (const pr of prods) pr.fotos = await persistPhotos(pr.fotos);
      state = { tienda, productos: prods };
      await saveState();
      await cleanupUploads();
    });
    return json(res, 200, state);
  }
  throw httpErr(404, "No encontrado.");
}

async function serveFile(req, res, file, cache) {
  let st;
  try { st = await fsp.stat(file); } catch (e) { return json(res, 404, { error: "No encontrado." }); }
  if (!st.isFile()) return json(res, 404, { error: "No encontrado." });
  res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Content-Length": st.size, "Cache-Control": cache });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    headers(res);
    let p;
    try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch (e) { throw httpErr(400, "Solicitud inválida."); }
    if (p === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok"); }
    if (p.startsWith("/api/")) return await api(req, res, p);
    if (req.method !== "GET" && req.method !== "HEAD") throw httpErr(405, "Método no permitido.");
    if (UP_RE.test(p)) {
      const [r] = await pool.query("SELECT tipo, datos FROM fotos WHERE nombre = ?", [p.slice(9)]);
      if (!r.length) return json(res, 404, { error: "No encontrado." });
      res.writeHead(200, { "Content-Type": r[0].tipo, "Content-Length": r[0].datos.length, "Cache-Control": "public, max-age=2592000, immutable" });
      return res.end(req.method === "HEAD" ? undefined : r[0].datos);
    }
    
    // INYECCIÓN DE META TAGS (Open Graph) PARA VISTA PREVIA
    if (p === "/" || p === "/index.html") {
      try {
        let html = await fsp.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
        const t = state.tienda;
        const host = req.headers.host || "zapatos-8xb2.onrender.com";
        const protocol = isHttps(req) ? "https" : "http";
        const baseUrl = protocol + "://" + host;
        
        const metaTags = `
    <meta property="og:title" content="${escHtml(t.nombre)} - ${escHtml(t.ciudad)}">
    <meta property="og:description" content="${escHtml(t.bienvenida || 'Zapatos que aguantan la masticada de verdad.')}">
    <meta property="og:image" content="${baseUrl}/pcueca-emblema.png">
    <meta property="og:url" content="${baseUrl}/">
    <meta property="og:type" content="website">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escHtml(t.nombre)}">
    <meta name="twitter:description" content="${escHtml(t.bienvenida || 'Zapatos que aguantan la masticada de verdad.')}">
    <meta name="twitter:image" content="${baseUrl}/pcueca-emblema.png">`;
        
        html = html.replace("</head>", metaTags + "\n</head>");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        return res.end(html);
      } catch (err) {
        console.error("Error inyectando meta tags:", err);
        // Si falla, sigue al serveFile normal
      }
    }

    if (p === "/") p = "/index.html";
    const file = path.join(PUBLIC_DIR, p);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw httpErr(404, "No encontrado.");
    return await serveFile(req, res, file, "no-cache");
  } catch (e) {
    if (e && e.status) return json(res, e.status, { error: e.message });
    console.error(e);
    json(res, 500, { error: "Error del servidor." });
  }
});
initDb().then(() => {
  server.listen(PORT, () => console.log("Tienda lista en el puerto " + PORT + " · datos en MySQL"));
}).catch((e) => {
  console.error("No se pudo conectar a MySQL:", e.code || "", e.message);
  process.exit(1);
});
