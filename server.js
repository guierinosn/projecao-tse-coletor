
import express from "express";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;
const ELEICAO = "6258";
const ELEICAO_ARQ = "006258";
const ELEICAO_1T = "6257";
const BASE = `https://resultados.tse.jus.br/oficial/ele2026/${ELEICAO}`;
const UFS = [
  "ac","al","am","ap","ba","ce","df","es","go","ma","mg","ms",
  "mt","pa","pb","pe","pi","pr","rj","rn","ro","rr","rs","sc","se","sp","to"
];

const NOMES_UF = {
  ac:"Acre", al:"Alagoas", am:"Amazonas", ap:"Amapá",
  ba:"Bahia", ce:"Ceará", df:"Distrito Federal",
  es:"Espírito Santo", go:"Goiás", ma:"Maranhão",
  mg:"Minas Gerais", ms:"Mato Grosso do Sul", mt:"Mato Grosso",
  pa:"Pará", pb:"Paraíba", pe:"Pernambuco", pi:"Piauí",
  pr:"Paraná", rj:"Rio de Janeiro", rn:"Rio Grande do Norte",
  ro:"Rondônia", rr:"Roraima", rs:"Rio Grande do Sul",
  sc:"Santa Catarina", se:"Sergipe", sp:"São Paulo", to:"Tocantins"
};

const CONFIG_URLS = [
  `https://resultados.tse.jus.br/oficial/ele2026/${ELEICAO}/config/mun-e${ELEICAO_ARQ}-cm.json`,
  `https://resultados.tse.jus.br/oficial/ele2026/${ELEICAO_1T}/config/mun-e${ELEICAO_1T}-cm.json`
];

const URL_NACIONAL_ACOMP =
  `${BASE}/dados/br/br-e${ELEICAO_ARQ}-ab.json`;

const URL_NACIONAL_PRESIDENTE =
  `${BASE}/dados/br/br-c0001-e${ELEICAO_ARQ}-u.json`;

const cache = {
  config: null,
  configAt: 0,
  national: null,
  nationalAt: 0,
  municipalities: new Map(),
  refreshStarted: false,
  refreshStatus: "Aguardando inicialização"
};

const CACHE_MS = 25000;
const MUNICIPIO_CACHE_MS = 90000;

function num(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  const n = Number(
    s.includes(",")
      ? s.replace(/\./g, "").replace(",", ".")
      : s
  );
  return Number.isFinite(n) ? n : 0;
}

function pct(a, b) {
  return b > 0 ? a / b * 100 : 0;
}

async function buscarJson(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { "User-Agent": "ProjecaoBrasil/1.0" }
    });

    if (!response.ok) {
      throw new Error(`TSE respondeu HTTP ${response.status}: ${url}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function obterConfiguracao() {
  if (cache.config && Date.now() - cache.configAt < 3600000) {
    return cache.config;
  }

  const falhas = [];

  for (const url of CONFIG_URLS) {
    try {
      const data = await buscarJson(url);

      if (!Array.isArray(data?.abr)) {
        throw new Error(`Formato inesperado no arquivo: ${url}`);
      }

      const municipios = [];

      for (const estado of data.abr) {
        const uf = String(estado.cd ?? estado.uf ?? "")
          .trim()
          .toLowerCase();

        if (!UFS.includes(uf) || !Array.isArray(estado.mu)) continue;

        for (const m of estado.mu) {
          const codigo = String(m.cd ?? "").trim().padStart(5, "0");

          if (!/^\d{5}$/.test(codigo)) continue;

          municipios.push({
            uf,
            codigo,
            ibge: String(m.cdi ?? "").trim(),
            nome: String(m.nm ?? "").trim()
          });
        }
      }

      if (municipios.length === 0) {
        throw new Error(`Nenhum município encontrado em ${url}`);
      }

      cache.config = {
        geracao: data.idg ?? null,
        data: data.dg ?? null,
        hora: data.hg ?? null,
        arquivoConfiguracao: url,
        municipios
      };

      cache.configAt = Date.now();
      return cache.config;
    } catch (e) {
      falhas.push(e.message);
    }
  }

  throw new Error(
    "Não foi possível carregar a configuração municipal. " +
    falhas.join(" || ")
  );
}

function walk(root, fn, depth = 0, seen = new Set()) {
  if (!root || typeof root !== "object" || depth > 14 || seen.has(root)) return;

  seen.add(root);
  fn(root);

  for (const v of Array.isArray(root) ? root : Object.values(root)) {
    walk(v, fn, depth + 1, seen);
  }
}

function findStats(root) {
  let found = null;

  walk(root, o => {
    if (!found && !Array.isArray(o) && o.s && o.e) found = o;
  });

  return found || {};
}

function findCandidates(root) {
  const map = new Map();

  walk(root, arr => {
    if (!Array.isArray(arr)) return;

    for (const c of arr) {
      if (!c || typeof c !== "object") continue;
      if (c.vap === undefined && c.pvap === undefined) continue;

      const id = String(c.sqcand ?? c.n ?? c.nr ?? "").trim();
      const name = String(c.nm ?? c.nmu ?? c.nome ?? "").trim();
      if (!id && !name) continue;

      const key = id || name;
      const item = {
        numero: id,
        nome: name || id,
        votos: num(c.vap),
        percentual: num(c.pvap),
        partido: String(c.sg ?? c.part ?? "").trim()
      };

      const old = map.get(key);
      if (!old || item.votos > old.votos) map.set(key, item);
    }
  });

  return [...map.values()].sort((a, b) => b.votos - a.votos);
}

function resumir(data, uf) {
  const x = findStats(data);
  const s = x.s || {};
  const e = x.e || {};
  const v = x.v || {};

  return {
    uf,
    estado: NOMES_UF[uf] || uf.toUpperCase(),
    geracao: data?.idg ?? null,
    dataGeracao: data?.dg ?? null,
    horaGeracao: data?.hg ?? null,
    secoesTotal: num(s.ts),
    secoesTotalizadas: num(s.st),
    apuracaoSecoesPct: pct(num(s.st), num(s.ts)),
    eleitoradoApto: num(e.te),
    eleitoradoTotalizado: num(e.est),
    apuracaoEleitoradoPct: pct(num(e.est), num(e.te)),
    votosValidos: num(v.vvc),
    votosBrancos: num(v.vb),
    votosNulos: num(v.vn),
    candidatos: findCandidates(data)
  };
}

async function obterResultadoMunicipal(m) {
  const key = `${m.uf}/${m.codigo}`;
  const old = cache.municipalities.get(key);

  if (old && Date.now() - old.at < MUNICIPIO_CACHE_MS) {
    return old.data;
  }

  const url =
    `${BASE}/dados/${m.uf}/${m.uf}${m.codigo}-c0001-e${ELEICAO_ARQ}-u.json`;

  const data = await buscarJson(url, 10000);

  const result = {
    ...resumir(data, m.uf),
    codigo: m.codigo,
    codigoIBGE: m.ibge,
    municipio: m.nome,
    arquivo: url
  };

  cache.municipalities.set(key, { at: Date.now(), data: result });
  return result;
}

async function atualizarCacheMunicipal() {
  if (cache.refreshStarted) return;

  cache.refreshStarted = true;
  cache.refreshStatus = "Carregando configuração municipal";

  try {
    const config = await obterConfiguracao();
    const rows = config.municipios;
    let success = 0;
    let failed = 0;
    const concurrency = 5;

    for (let i = 0; i < rows.length; i += concurrency) {
      const batch = rows.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(obterResultadoMunicipal)
      );

      for (const r of results) {
        if (r.status === "fulfilled") success++;
        else failed++;
      }

      cache.refreshStatus =
        `Carga municipal: ${success} lidos, ${failed} indisponíveis, ` +
        `${rows.length} previstos`;
    }

    cache.refreshStatus =
      `Carga municipal concluída: ${success} lidos, ${failed} indisponíveis`;
  } catch (e) {
    cache.refreshStatus = `Falha na carga municipal: ${e.message}`;
    console.error(cache.refreshStatus);
  } finally {
    cache.refreshStarted = false;
  }
}

function projetarMunicipios(rows, totalConfigurado = rows.length) {
  const byCandidate = new Map();

  let eligible = 0;
  let countedElectorate = 0;
  let totalSections = 0;
  let countedSections = 0;
  let officialValid = 0;
  let officialWhite = 0;
  let officialNull = 0;
  let projectedValid = 0;
  let projectedWhite = 0;
  let projectedNull = 0;
  let projectedAbstention = 0;
  let municipalitiesLoaded = 0;

  for (const m of rows) {
    eligible += m.eleitoradoApto;
    countedElectorate += m.eleitoradoTotalizado;
    totalSections += m.secoesTotal;
    countedSections += m.secoesTotalizadas;
    officialValid += m.votosValidos;
    officialWhite += m.votosBrancos;
    officialNull += m.votosNulos;

    if (!m.eleitoradoApto || !m.eleitoradoTotalizado || !m.candidatos.length) {
      continue;
    }

    const countedBallots =
      m.votosValidos + m.votosBrancos + m.votosNulos;

    if (countedBallots <= 0) continue;

    municipalitiesLoaded++;

    const factor = m.eleitoradoApto / m.eleitoradoTotalizado;
    const projectedVoters = countedBallots * factor;

    projectedValid += m.votosValidos * factor;
    projectedWhite += m.votosBrancos * factor;
    projectedNull += m.votosNulos * factor;
    projectedAbstention += Math.max(0, m.eleitoradoApto - projectedVoters);

    for (const c of m.candidatos) {
      const key = c.numero || c.nome;
      const old = byCandidate.get(key) || {
        numero: c.numero,
        nome: c.nome,
        partido: c.partido,
        votosOficiais: 0,
        votosProjetados: 0
      };

      old.votosOficiais += c.votos;
      old.votosProjetados += c.votos * factor;
      byCandidate.set(key, old);
    }
  }

  const candidates = [...byCandidate.values()]
    .sort((a, b) => b.votosProjetados - a.votosProjetados);

  const totalCandidateVotes = candidates.reduce(
    (sum, c) => sum + c.votosProjetados, 0
  );

  for (const c of candidates) {
    c.percentualProjetado = pct(c.votosProjetados, totalCandidateVotes);
  }

  return {
    eleitoradoApto: eligible,
    eleitoradoTotalizado: countedElectorate,
    apuracaoEleitoradoPct: pct(countedElectorate, eligible),
    secoesTotal: totalSections,
    secoesTotalizadas: countedSections,
    apuracaoSecoesPct: pct(countedSections, totalSections),
    votosValidosOficiais: officialValid,
    votosBrancosOficiais: officialWhite,
    votosNulosOficiais: officialNull,
    votosValidosProjetados: projectedValid,
    votosBrancosProjetados: projectedWhite,
    votosNulosProjetados: projectedNull,
    abstencoesProjetadas: projectedAbstention,
    candidatos: candidates,
    municipiosConfigurados: totalConfigurado,
    municipiosComDados: municipalitiesLoaded,
    municipiosPendentes: Math.max(0, totalConfigurado - municipalitiesLoaded),
    observacao:
      "Estimativa preliminar baseada nos municípios com dados válidos. " +
      "Municípios sem dados não recebem votos inventados. " +
      "A projeção não deve ser interpretada como resultado oficial."
  };
}

async function obterBrasil() {
  if (cache.national && Date.now() - cache.nationalAt < CACHE_MS) {
    return { ...cache.national, cache: true };
  }

  const [tracking, president, stateResults] = await Promise.all([
    buscarJson(URL_NACIONAL_ACOMP)
      .then(value => ({ status: "fulfilled", value }))
      .catch(reason => ({ status: "rejected", reason })),

    buscarJson(URL_NACIONAL_PRESIDENTE)
      .then(value => ({ status: "fulfilled", value }))
      .catch(reason => ({ status: "rejected", reason })),

    Promise.allSettled(UFS.map(async uf => {
      const url = `${BASE}/dados/${uf}/${uf}-e${ELEICAO_ARQ}-ab.json`;
      const data = await buscarJson(url, 8000);
      return { ...resumir(data, uf), arquivo: url };
    }))
  ]);

  const trackingData = tracking.status === "fulfilled" ? tracking.value : null;
  const presidentData = president.status === "fulfilled" ? president.value : null;

  const estados = [];
  const falhasEstados = [];

  stateResults.forEach((r, i) => {
    if (r.status === "fulfilled") estados.push(r.value);
    else falhasEstados.push({
      uf: UFS[i],
      erro: r.reason?.message || "Falha na consulta"
    });
  });

  let config = null;
  let erroConfiguracao = null;

  try {
    config = await obterConfiguracao();
  } catch (e) {
    erroConfiguracao = e.message;
  }

  const result = {
    ok: true,
    fonte: "TSE",
    eleicao: ELEICAO,
    turno: 2,
    consultadoEm: new Date().toISOString(),
    acompanhamentoNacionalDisponivel: !!trackingData,
    erroAcompanhamentoNacional:
      tracking.status === "rejected" ? tracking.reason.message : null,
    resultadoPresidencialDisponivel: !!presidentData,
    erroResultadoPresidencial:
      president.status === "rejected" ? president.reason.message : null,
    erroConfiguracao,
    arquivos: {
      acompanhamento: URL_NACIONAL_ACOMP,
      resultadoPresidencial: URL_NACIONAL_PRESIDENTE,
      configuracoesMunicipais: CONFIG_URLS
    },
    oficial: trackingData ? resumir(trackingData, "br") : null,
    candidatosOficiais: presidentData ? findCandidates(presidentData) : [],
    estados,
    falhasEstados,
    configuracao: {
      municipios: config?.municipios.length ?? 0,
      geracao: config?.geracao ?? null,
      data: config?.data ?? null,
      arquivo: config?.arquivoConfiguracao ?? null
    },
    cargaMunicipal: {
      iniciada: cache.refreshStarted,
      status: cache.refreshStatus,
      municipiosEmCache: cache.municipalities.size
    }
  };

  cache.national = result;
  cache.nationalAt = Date.now();
  return { ...result, cache: false };
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    servico: "Projeção Brasil API",
    eleicao: ELEICAO,
    endpoints: [
      "/api/status",
      "/api/brasil",
      "/api/projecao",
      "/api/municipios",
      "/api/municipio/UF/CODIGO"
    ]
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    servico: "Projeção Brasil API",
    fonte: "TSE",
    eleicao: ELEICAO,
    horarioServidor: new Date().toISOString(),
    cargaMunicipal: cache.refreshStatus
  });
});

app.get("/api/brasil", async (_req, res, next) => {
  try {
    const data = await obterBrasil();
    if (!cache.refreshStarted && cache.municipalities.size === 0) {
      atualizarCacheMunicipal();
    }
    res.json(data);
  } catch (e) {
    next(e);
  }
});

app.get("/api/municipios", async (_req, res, next) => {
  try {
    const c = await obterConfiguracao();
    res.json({
      ok: true,
      total: c.municipios.length,
      geracao: c.geracao,
      data: c.data,
      arquivoConfiguracao: c.arquivoConfiguracao,
      municipios: c.municipios
    });
  } catch (e) {
    next(e);
  }
});

app.get("/api/municipio/:uf/:codigo", async (req, res, next) => {
  try {
    const uf = String(req.params.uf).trim().toLowerCase();
    const codigo = String(req.params.codigo).trim().padStart(5, "0");

    if (!UFS.includes(uf) || !/^\d{5}$/.test(codigo)) {
      return res.status(400).json({
        ok: false,
        erro: "UF ou código municipal inválido"
      });
    }

    const c = await obterConfiguracao();
    const m = c.municipios.find(x => x.uf === uf && x.codigo === codigo);

    if (!m) {
      return res.status(404).json({
        ok: false,
        erro: "Município não encontrado na configuração do TSE"
      });
    }

    res.json({ ok: true, ...await obterResultadoMunicipal(m) });
  } catch (e) {
    next(e);
  }
});

app.get("/api/projecao", async (_req, res, next) => {
  try {
    const c = await obterConfiguracao();

    if (!cache.refreshStarted &&
        cache.municipalities.size < c.municipios.length) {
      atualizarCacheMunicipal();
    }

    const rows = c.municipios
      .map(m => cache.municipalities.get(`${m.uf}/${m.codigo}`)?.data)
      .filter(Boolean);

    const projection = projetarMunicipios(rows, c.municipios.length);

    res.json({
      ok: true,
      fonte: "TSE",
      eleicao: ELEICAO,
      calculadoEm: new Date().toISOString(),
      carga: {
        status: cache.refreshStatus,
        emAndamento: cache.refreshStarted,
        municipiosCarregados: rows.length,
        municipiosConfigurados: c.municipios.length
      },
      projecao: projection,
      historicoDisponivel: false,
      observacao:
        "Projeção preliminar calculada com os dados municipais disponíveis. " +
        "O histórico persistente requer armazenamento externo."
    });
  } catch (e) {
    next(e);
  }
});

app.use((err, _req, res, _next) => {
  console.error("Erro no coletor:", err);
  res.status(502).json({
    ok: false,
    erro: err.message || "Erro no coletor",
    horarioServidor: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Projeção Brasil API ouvindo na porta ${PORT}`);
});
