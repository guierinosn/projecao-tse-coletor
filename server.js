
import express from "express";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const ELECTION_ID = "6258";
const BASE = `https://resultados.tse.jus.br/oficial/ele2026/${ELECTION_ID}`;
const CONFIG_URL = `${BASE}/config/mun-e${ELECTION_ID}-cm.json`;

const CACHE = {
  config: null,
  configAt: 0,
  municipalityResults: new Map(),
  national: null,
  nationalAt: 0
};

const UFS = [
  "ac", "al", "am", "ap", "ba", "ce", "df", "es", "go",
  "ma", "mg", "ms", "mt", "pa", "pb", "pe", "pi", "pr",
  "rj", "rn", "ro", "rr", "rs", "sc", "se", "sp", "to"
];

const UF_NAMES = {
  ac: "Acre", al: "Alagoas", am: "Amazonas", ap: "Amapá",
  ba: "Bahia", ce: "Ceará", df: "Distrito Federal",
  es: "Espírito Santo", go: "Goiás", ma: "Maranhão",
  mg: "Minas Gerais", ms: "Mato Grosso do Sul", mt: "Mato Grosso",
  pa: "Pará", pb: "Paraíba", pe: "Pernambuco", pi: "Piauí",
  pr: "Paraná", rj: "Rio de Janeiro", rn: "Rio Grande do Norte",
  ro: "Rondônia", rr: "Roraima", rs: "Rio Grande do Sul",
  sc: "Santa Catarina", se: "Sergipe", sp: "São Paulo",
  to: "Tocantins"
};

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

function toNumber(value) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const raw = String(value).trim();

  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw.replace(/\./g, "");

  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? parsed : 0;
}

function percent(part, total) {
  return total > 0 ? (part / total) * 100 : 0;
}

async function fetchJson(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "ProjecaoBrasil/1.0"
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(
        `TSE respondeu HTTP ${response.status} ao consultar ${url}`
      );
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function getUfCode(record) {
  return String(record?.cd ?? record?.uf ?? "")
    .trim()
    .toLowerCase();
}

async function getMunicipalityConfig() {
  const ttlMs = 60 * 60 * 1000;

  if (CACHE.config && Date.now() - CACHE.configAt < ttlMs) {
    return CACHE.config;
  }

  const data = await fetchJson(CONFIG_URL);

  if (!Array.isArray(data?.abr)) {
    throw new Error(
      "A configuração municipal recebida do TSE não contém a lista esperada."
    );
  }

  const municipalities = [];

  for (const state of data.abr) {
    const uf = getUfCode(state);

    if (!Array.isArray(state.mu)) {
      continue;
    }

    for (const municipality of state.mu) {
      municipalities.push({
        uf,
        codigo: String(municipality.cd ?? "")
          .trim()
          .padStart(5, "0"),
        ibge: String(municipality.cdi ?? "").trim(),
        nome: String(municipality.nm ?? "").trim(),
        zonas: Array.isArray(municipality.z)
          ? municipality.z
          : []
      });
    }
  }

  CACHE.config = {
    geracao: data.idg ?? null,
    data: data.dg ?? null,
    hora: data.hg ?? null,
    municipios: municipalities
  };

  CACHE.configAt = Date.now();

  return CACHE.config;
}

function validateMunicipalityParams(ufInput, codeInput) {
  const uf = String(ufInput ?? "").trim().toLowerCase();
  const codigo = String(codeInput ?? "")
    .trim()
    .padStart(5, "0");

  if (!UFS.includes(uf) || !/^\d{5}$/.test(codigo)) {
    const error = new Error("UF ou código municipal inválido.");
    error.status = 400;
    throw error;
  }

  return { uf, codigo };
}

async function getMunicipalityResult(ufInput, codeInput) {
  const { uf, codigo } = validateMunicipalityParams(
    ufInput,
    codeInput
  );

  const key = `${uf}/${codigo}`;
  const ttlMs = 45 * 1000;
  const cached = CACHE.municipalityResults.get(key);

  if (cached && Date.now() - cached.at < ttlMs) {
    return {
      ...cached.value,
      cache: true
    };
  }

  const url =
    `${BASE}/dados/${uf}/${uf}${codigo}-c0001-e${ELECTION_ID}-u.json`;

  const data = await fetchJson(url);
  const config = await getMunicipalityConfig();

  const entry = config.municipios.find(
    item => item.uf === uf && item.codigo === codigo
  );

  const value = {
    ok: true,
    fonte: "TSE",
    eleicao: ELECTION_ID,
    turno: 2,
    municipio:
      entry?.nome ||
      String(data?.nmabr ?? data?.cdabr ?? codigo),
    uf,
    codigo,
    codigoIBGE: entry?.ibge || null,
    arquivo: url,
    consultadoEm: new Date().toISOString(),
    geracao: data?.idg ?? null,
    dados: data
  };

  CACHE.municipalityResults.set(key, {
    at: Date.now(),
    value
  });

  return {
    ...value,
    cache: false
  };
}

function walkObjects(
  root,
  callback,
  depth = 0,
  seen = new Set()
) {
  if (
    !root ||
    typeof root !== "object" ||
    depth > 14 ||
    seen.has(root)
  ) {
    return;
  }

  seen.add(root);
  callback(root);

  if (Array.isArray(root)) {
    for (const item of root) {
      walkObjects(item, callback, depth + 1, seen);
    }

    return;
  }

  for (const value of Object.values(root)) {
    walkObjects(value, callback, depth + 1, seen);
  }
}

function findStatisticsObject(root) {
  let found = null;

  walkObjects(root, object => {
    if (
      !found &&
      !Array.isArray(object) &&
      object.s &&
      object.e
    ) {
      found = object;
    }
  });

  return found || {};
}

function extractCandidates(root) {
  const found = new Map();

  walkObjects(root, object => {
    if (!Array.isArray(object) || !object.length) {
      return;
    }

    for (const candidate of object) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }

      const hasVoteFields =
        candidate.vap !== undefined ||
        candidate.pvap !== undefined;

      if (!hasVoteFields) {
        continue;
      }

      const number = String(
        candidate.n ?? candidate.sqcand ?? ""
      ).trim();

      if (!number) {
        continue;
      }

      const candidateData = {
        numero: number,
        nome: String(
          candidate.nm ?? candidate.nmu ?? number
        ).trim(),
        votos: toNumber(candidate.vap),
        percentual: toNumber(candidate.pvap)
      };

      const previous = found.get(number);

      if (
        !previous ||
        candidateData.votos > previous.votos
      ) {
        found.set(number, candidateData);
      }
    }
  });

  return [...found.values()].sort(
    (a, b) => b.votos - a.votos
  );
}

function summarizeState(data, uf) {
  const stats = findStatisticsObject(data);
  const s = stats.s || {};
  const e = stats.e || {};
  const v = stats.v || {};

  const totalSections = toNumber(s.ts);
  const countedSections = toNumber(s.st);
  const eligibleElectorate = toNumber(e.te);
  const countedElectorate = toNumber(e.est);

  return {
    uf,
    estado: UF_NAMES[uf] || uf.toUpperCase(),
    geracao: data?.idg ?? null,
    dataGeracao: data?.dg ?? null,
    horaGeracao: data?.hg ?? null,

    secoesTotal: totalSections,
    secoesTotalizadas: countedSections,
    apuracaoSecoesPct: percent(
      countedSections,
      totalSections
    ),

    eleitoradoApto: eligibleElectorate,
    eleitoradoTotalizado: countedElectorate,
    apuracaoEleitoradoPct: percent(
      countedElectorate,
      eligibleElectorate
    ),

    votosValidos: toNumber(v.vvc),
    votosBrancos: toNumber(v.vb),
    votosNulos: toNumber(v.vn),

    candidatos: extractCandidates(data)
  };
}

async function getStateResult(uf) {
  const urls = [
    `${BASE}/dados/${uf}/${uf}-e${ELECTION_ID}-ab.json`,
    `${BASE}/dados/${uf}/${uf}-e${ELECTION_ID}-u.json`
  ];

  let lastError;

  for (const url of urls) {
    try {
      return {
        data: await fetchJson(url, 8000),
        arquivo: url
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ||
    new Error(
      `Não foi possível obter os dados de ${uf.toUpperCase()}.`
    );
}

async function getBrazilSummary() {
  const ttlMs = 25 * 1000;

  if (
    CACHE.national &&
    Date.now() - CACHE.nationalAt < ttlMs
  ) {
    return {
      ...CACHE.national,
      cache: true
    };
  }

  const startedAt = Date.now();

  const nationalUrl =
    `${BASE}/dados/br/br-e${ELECTION_ID}-ab.json`;

  let nationalFile = null;
  let nationalError = null;

  try {
    nationalFile = await fetchJson(nationalUrl, 10000);
  } catch (error) {
    nationalError = error.message;
  }

  const settled = await Promise.allSettled(
    UFS.map(async uf => {
      const result = await getStateResult(uf);

      return {
        ...summarizeState(result.data, uf),
        arquivo: result.arquivo
      };
    })
  );

  const states = [];
  const failures = [];

  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      states.push(result.value);
    } else {
      failures.push({
        uf: UFS[index],
        erro:
          result.reason?.message ||
          "Falha desconhecida na consulta estadual."
      });
    }
  });

  const candidateMap = new Map();

  for (const state of states) {
    for (const candidate of state.candidatos) {
      const key = candidate.numero;

      const existing = candidateMap.get(key) || {
        numero: candidate.numero,
        nome: candidate.nome,
        votos: 0
      };

      existing.votos += candidate.votos;

      if (
        !existing.nome ||
        existing.nome === existing.numero
      ) {
        existing.nome = candidate.nome;
      }

      candidateMap.set(key, existing);
    }
  }

  const sum = field =>
    states.reduce(
      (total, state) =>
        total + (Number(state[field]) || 0),
      0
    );

  const totalSections = sum("secoesTotal");
  const countedSections = sum("secoesTotalizadas");
  const eligibleElectorate = sum("eleitoradoApto");
  const countedElectorate = sum("eleitoradoTotalizado");

  const payload = {
    ok: true,
    fonte: "TSE",
    eleicao: ELECTION_ID,
    turno: 2,

    consultadoEm: new Date().toISOString(),
    duracaoMs: Date.now() - startedAt,

    arquivoNacional: nationalUrl,
    geracaoNacional: nationalFile?.idg ?? null,
    nacionalDisponivel: Boolean(nationalFile),
    erroNacional: nationalError,

    cobertura: {
      estadosConsultados: states.length,
      estadosEsperados: 27,
      coberturaCompleta: states.length === 27,
      falhas,

      secoesTotal: totalSections,
      secoesTotalizadas: countedSections,
      apuracaoSecoesPct: percent(
        countedSections,
        totalSections
      ),

      eleitoradoApto: eligibleElectorate,
      eleitoradoTotalizado: countedElectorate,
      apuracaoEleitoradoPct: percent(
        countedElectorate,
        eligibleElectorate
      )
    },

    candidatos: [...candidateMap.values()].sort(
      (a, b) => b.votos - a.votos
    ),

    estados: states,

    observacao:
      "Esta rota é um diagnóstico agregado dos arquivos estaduais encontrados. " +
      "Não representa, por si só, a projeção estatística municipal. " +
      "Se a cobertura for menor que 27 UFs, os totais são parciais."
  };

  CACHE.national = payload;
  CACHE.nationalAt = Date.now();

  return {
    ...payload,
    cache: false
  };
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    servico: "Projeção Brasil — Coletor",
    eleicao: ELECTION_ID,
    endpoints: [
      "/api/status",
      "/api/brasil",
      "/api/municipios",
      "/api/diagnostico-municipios",
      "/api/municipio/uf/codigo"
    ]
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    servico: "Projeção Brasil — Coletor",
    fonte: "TSE",
    eleicao: ELECTION_ID,
    cacheMunicipioSegundos: 45,
    cacheBrasilSegundos: 25,
    horarioServidor: new Date().toISOString()
  });
});

app.get("/api/municipios", async (_req, res, next) => {
  try {
    const config = await getMunicipalityConfig();

    res.json({
      ok: true,
      fonte: "TSE",
      dataConfiguracao: config.data,
      horaConfiguracao: config.hora,
      geracaoConfiguracao: config.geracao,
      total: config.municipios.length,
      municipios: config.municipios
    });
  } catch (error) {
    next(error);
  }
});

app.get(
  "/api/diagnostico-municipios",
  async (_req, res, next) => {
    try {
      const config = await getMunicipalityConfig();
      const rows = config.municipios;

      const municipalCodes = rows
        .map(item => item.codigo)
        .filter(Boolean);

      const ibgeCodes = rows
        .map(item => item.ibge)
        .filter(Boolean);

      const uniqueCount = values =>
        new Set(values).size;

      res.json({
        ok: true,
        dataConfiguracao: config.data,
        horaConfiguracao: config.hora,
        geracaoConfiguracao: config.geracao,

        registrosOriginais: rows.length,

        codigosMunicipaisUnicos:
          uniqueCount(municipalCodes),

        codigosMunicipaisRepetidos:
          municipalCodes.length -
          uniqueCount(municipalCodes),

        codigosIBGEUnicos:
          uniqueCount(ibgeCodes),

        codigosIBGERepetidos:
          ibgeCodes.length -
          uniqueCount(ibgeCodes),

        registrosSemIBGE:
          rows.filter(item => !item.ibge).length,

        totalUFs: [
          ...new Set(rows.map(item => item.uf))
        ].length,

        UFs: [
          ...new Set(rows.map(item => item.uf))
        ]
      });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/municipio/:uf/:codigo",
  async (req, res, next) => {
    try {
      res.json(
        await getMunicipalityResult(
          req.params.uf,
          req.params.codigo
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

app.get("/api/brasil", async (_req, res, next) => {
  try {
    res.json(await getBrazilSummary());
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error.status || 502;

  res.status(status).json({
    ok: false,
    erro:
      error.message ||
      "Falha inesperada no coletor.",
    horarioServidor: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(
    `Projeção Brasil coletor ouvindo na porta ${PORT}`
  );
});
