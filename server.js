
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

const BASE =
  "https://resultados.tse.jus.br/oficial/ele2026/6258";

const CONFIG_URL = `${BASE}/config/mun-e006258-cm.json`;
const CACHE_MS = 60_000;
const TIMEOUT_MS = 15_000;

const cache = new Map();
let configCache = null;
let configCacheAt = 0;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

async function buscarJSON(url) {
  const resposta = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0"
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  if (!resposta.ok) {
    throw new Error(`TSE respondeu HTTP ${resposta.status}`);
  }

  return resposta.json();
}

async function obterConfiguracao() {
  if (configCache && Date.now() - configCacheAt < 3600000) {
    return configCache;
  }

  const dados = await buscarJSON(CONFIG_URL);

  if (!Array.isArray(dados.abr)) {
    throw new Error("Formato inesperado na configuração municipal do TSE.");
  }

  configCache = dados;
  configCacheAt = Date.now();

  return dados;
}

function normalizarCodigo(valor) {
  return String(valor).trim().padStart(5, "0");
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    servico: "Projeção Brasil — Coletor",
    rotas: [
      "/api/status",
      "/api/municipios",
      "/api/municipio/ac/01473"
    ]
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    servico: "Projeção Brasil — Coletor",
    fonte: "TSE",
    cacheResultadosSegundos: CACHE_MS / 1000
  });
});


app.get("/api/municipios", async (req, res) => {
  try {
    const config = await obterConfiguracao();
    const mapa = new Map();

    for (const estado of config.abr) {
      const uf = String(estado.cd || "").trim().toLowerCase();

      for (const municipio of estado.mu || []) {
        const codigo = normalizarCodigo(municipio.cd);

        if (!/^[a-z]{2}$/.test(uf) || !/^\d{5}$/.test(codigo)) {
          continue;
        }

        const chave = `${uf}-${codigo}`;

        mapa.set(chave, {
          uf,
          codigo,
          codigoIBGE: String(municipio.cdi || "").trim() || null,
          nome: String(municipio.nm || "").trim(),
          capital: municipio.c === "s",
          zonas: municipio.z || []
        });
      }
    }

    const municipios = [...mapa.values()].sort(
      (a, b) =>
        a.uf.localeCompare(b.uf) ||
        a.nome.localeCompare(b.nome, "pt-BR")
    );

    res.json({
      ok: true,
      fonte: "TSE",
      atualizadoEm: new Date().toISOString(),
      totalMunicipios: municipios.length,
      municipios
    });
  } catch (erro) {
    res.status(502).json({
      ok: false,
      erro: String(erro),
      consultadoEm: new Date().toISOString()
    });
  }
});

  try {
    const config = await obterConfiguracao();
    const municipios = [];

    for (const estado of config.abr) {
      for (const municipio of estado.mu || []) {
        municipios.push({
          uf: String(estado.cd || "").toLowerCase(),
          codigo: normalizarCodigo(municipio.cd),
          codigoIBGE: municipio.cdi || null,
          nome: municipio.nm,
          capital: municipio.c === "s",
          zonas: municipio.z || []
        });
      }
    }

    res.json({
      ok: true,
      fonte: "TSE",
      atualizadoEm: new Date().toISOString(),
      totalMunicipios: municipios.length,
      municipios
    });
  } catch (erro) {
    res.status(502).json({
      ok: false,
      erro: String(erro),
      consultadoEm: new Date().toISOString()
    });
  }
});

app.get("/api/municipio/:uf/:codigo", async (req, res) => {
  try {
    const uf = String(req.params.uf).toLowerCase();
    const codigo = normalizarCodigo(req.params.codigo);

    if (!/^[a-z]{2}$/.test(uf) || !/^\d{5}$/.test(codigo)) {
      return res.status(400).json({
        ok: false,
        erro: "Informe uma UF válida e um código municipal de cinco dígitos."
      });
    }

    const chave = `${uf}-${codigo}`;
    const anterior = cache.get(chave);

    if (anterior && Date.now() - anterior.at < CACHE_MS) {
      return res.json({
        ...anterior.resposta,
        cache: true
      });
    }

    const config = await obterConfiguracao();
    const estado = config.abr.find(
      item => String(item.cd || "").toLowerCase() === uf
    );

    const municipio = estado?.mu?.find(
      item => normalizarCodigo(item.cd) === codigo
    );

    if (!municipio) {
      return res.status(404).json({
        ok: false,
        erro: "Município não encontrado na configuração do TSE.",
        uf,
        codigo
      });
    }

    const url =
      `${BASE}/dados/${uf}/${uf}${codigo}-c0001-e006258-u.json`;

    const dados = await buscarJSON(url);

    const resposta = {
      ok: true,
      fonte: "TSE",
      municipio: municipio.nm,
      uf,
      codigo,
      arquivo: url,
      consultadoEm: new Date().toISOString(),
      geracao: dados.idg || null,
      dados
    };

    cache.set(chave, {
      at: Date.now(),
      resposta
    });

    res.json({
      ...resposta,
      cache: false
    });
  } catch (erro) {
    res.status(502).json({
      ok: false,
      erro: "Não foi possível consultar os resultados municipais.",
      detalhe: String(erro),
      consultadoEm: new Date().toISOString()
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
