
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const TSE_URL =
  "https://resultados.tse.jus.br/oficial/ele2026/6258/dados/br/br-c0001-e006258-u.json";

const CACHE_MS = 30_000;
let cache = null;
let cacheAt = 0;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    servico: "Projeção Brasil — Coletor",
    rotas: ["/api/status", "/api/brasil", "/api/diagnostico"]
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    servico: "Projeção Brasil — Coletor",
    fonte: "TSE",
    cacheSegundos: CACHE_MS / 1000
  });
});

async function buscarTSE() {
  const resposta = await fetch(TSE_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0"
    },
    signal: AbortSignal.timeout(15000)
  });

  if (!resposta.ok) {
    throw new Error(`TSE respondeu HTTP ${resposta.status}`);
  }

  return await resposta.json();
}

app.get("/api/brasil", async (req, res) => {
  try {
    if (cache && Date.now() - cacheAt < CACHE_MS) {
      return res.json({
        ...cache,
        cache: true
      });
    }

    const dados = await buscarTSE();

    cache = {
      ok: true,
      fonte: "TSE",
      arquivo: "Resultado nacional — Presidente — 2º turno",
      consultadoEm: new Date().toISOString(),
      geracao: dados.idg,
      dados
    };

    cacheAt = Date.now();

    res.json({
      ...cache,
      cache: false
    });
  } catch (erro) {
    res.status(502).json({
      ok: false,
      fonte: "TSE",
      erro: "Não foi possível consultar os resultados oficiais.",
      detalhe: String(erro),
      consultadoEm: new Date().toISOString()
    });
  }
});

app.get("/api/diagnostico", async (req, res) => {
  try {
    const dados = await buscarTSE();

    res.json({
      ok: true,
      statusOrigem: 200,
      geracao: dados.idg,
      data: dados.dg,
      hora: dados.hg,
      amostra: JSON.stringify(dados).slice(0, 500),
      consultadoEm: new Date().toISOString()
    });
  } catch (erro) {
    res.status(502).json({
      ok: false,
      erro: String(erro),
      consultadoEm: new Date().toISOString()
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
