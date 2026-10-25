
import express from "express";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const ELEICAO = "6258";
const BASE = `https://resultados.tse.jus.br/oficial/ele2026/${ELEICAO}`;
const CONFIG_URL = `${BASE}/config/mun-e${ELEICAO}-cm.json`;

const UFS = [
  "ac", "al", "am", "ap", "ba", "ce", "df", "es", "go",
  "ma", "mg", "ms", "mt", "pa", "pb", "pe", "pi", "pr",
  "rj", "rn", "ro", "rr", "rs", "sc", "se", "sp", "to"
];

const NOMES_UF = {
  ac: "Acre", al: "Alagoas", am: "Amazonas", ap: "Amapá",
  ba: "Bahia", ce: "Ceará", df: "Distrito Federal",
  es: "Espírito Santo", go: "Goiás", ma: "Maranhão",
  mg: "Minas Gerais", ms: "Mato Grosso do Sul",
  mt: "Mato Grosso", pa: "Pará", pb: "Paraíba",
  pe: "Pernambuco", pi: "Piauí", pr: "Paraná",
  rj: "Rio de Janeiro", rn: "Rio Grande do Norte",
  ro: "Rondônia", rr: "Roraima", rs: "Rio Grande do Sul",
  sc: "Santa Catarina", se: "Sergipe", sp: "São Paulo",
  to: "Tocantins"
};

const cache = {
  configuracao: null,
  configuracaoEm: 0,
  municipios: new Map(),
  brasil: null,
  brasilEm: 0
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

function numero(valor) {
  if (valor === undefined || valor === null || valor === "") {
    return 0;
  }

  if (typeof valor === "number") {
    return Number.isFinite(valor) ? valor : 0;
  }

  const texto = String(valor).trim();

  const normalizado = texto.includes(",")
    ? texto.replace(/\./g, "").replace(",", ".")
    : texto.replace(/\./g, "");

  const resultado = Number(normalizado);

  return Number.isFinite(resultado) ? resultado : 0;
}

function percentual(parte, total) {
  return total > 0 ? (parte / total) * 100 : 0;
}

async function buscarJson(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resposta = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "ProjecaoBrasil/1.0"
      },
      cache: "no-store"
    });

    if (!resposta.ok) {
      throw new Error(`TSE respondeu HTTP ${resposta.status}`);
    }

    return await resposta.json();
  } finally {
    clearTimeout(timer);
  }
}

async function obterConfiguracao() {
  if (
    cache.configuracao &&
    Date.now() - cache.configuracaoEm < 3600000
  ) {
    return cache.configuracao;
  }

  const dados = await buscarJson(CONFIG_URL);

  if (!Array.isArray(dados?.abr)) {
    throw new Error("Formato inesperado da configuração municipal do TSE.");
  }

  const municipios = [];

  for (const estado of dados.abr) {
    const uf = String(estado.cd ?? estado.uf ?? "")
      .trim()
      .toLowerCase();

    if (!Array.isArray(estado.mu)) continue;

    for (const municipio of estado.mu) {
      municipios.push({
        uf,
        codigo: String(municipio.cd ?? "")
          .trim()
          .padStart(5, "0"),
        codigoIBGE: String(municipio.cdi ?? "").trim(),
        nome: String(municipio.nm ?? "").trim()
      });
    }
  }

  cache.configuracao = {
    geracao: dados.idg ?? null,
    data: dados.dg ?? null,
    hora: dados.hg ?? null,
    municipios
  };

  cache.configuracaoEm = Date.now();

  return cache.configuracao;
}

function localizarObjetos(raiz, criterio) {
  const encontrados = [];
  const visitados = new Set();

  function percorrer(objeto, profundidade = 0) {
    if (
      !objeto ||
      typeof objeto !== "object" ||
      profundidade > 12 ||
      visitados.has(objeto)
    ) {
      return;
    }

    visitados.add(objeto);

    if (!Array.isArray(objeto) && criterio(objeto)) {
      encontrados.push(objeto);
    }

    if (Array.isArray(objeto)) {
      for (const item of objeto) {
        percorrer(item, profundidade + 1);
      }
    } else {
      for (const valor of Object.values(objeto)) {
        percorrer(valor, profundidade + 1);
      }
    }
  }

  percorrer(raiz);
  return encontrados;
}

function resumirEstado(dados, uf) {
  const objetos = localizarObjetos(
    dados,
    objeto => objeto.s && objeto.e
  );

  const estatisticas = objetos[0] || {};
  const secoes = estatisticas.s || {};
  const eleitorado = estatisticas.e || {};
  const votos = estatisticas.v || {};

  const totalSecoes = numero(secoes.ts);
  const secoesTotalizadas = numero(secoes.st);
  const totalEleitores = numero(eleitorado.te);
  const eleitoresTotalizados = numero(eleitorado.est);

  return {
    uf,
    estado: NOMES_UF[uf] || uf.toUpperCase(),
    geracao: dados?.idg ?? null,
    dataGeracao: dados?.dg ?? null,
    horaGeracao: dados?.hg ?? null,

    secoesTotal: totalSecoes,
    secoesTotalizadas,
    apuracaoSecoesPct: percentual(
      secoesTotalizadas,
      totalSecoes
    ),

    eleitoradoApto: totalEleitores,
    eleitoradoTotalizado: eleitoresTotalizados,
    apuracaoEleitoradoPct: percentual(
      eleitoresTotalizados,
      totalEleitores
    ),

    votosValidos: numero(votos.vvc),
    votosBrancos: numero(votos.vb),
    votosNulos: numero(votos.vn)
  };
}

async function buscarResultadoEstadual(uf) {
  const urls = [
    `${BASE}/dados/${uf}/${uf}-e${ELEICAO}-ab.json`,
    `${BASE}/dados/${uf}/${uf}-e${ELEICAO}-u.json`
  ];

  let ultimoErro;

  for (const url of urls) {
    try {
      const dados = await buscarJson(url, 8000);

      return {
        ...resumirEstado(dados, uf),
        arquivo: url
      };
    } catch (erro) {
      ultimoErro = erro;
    }
  }

  throw new Error(
    `${uf.toUpperCase()}: ${
      ultimoErro?.message || "arquivos estaduais indisponíveis"
    }`
  );
}

async function obterBrasil() {
  if (
    cache.brasil &&
    Date.now() - cache.brasilEm < 25000
  ) {
    return {
      ...cache.brasil,
      cache: true
    };
  }

  const inicio = Date.now();
  const urlNacional = `${BASE}/dados/br/br-e${ELEICAO}-ab.json`;

  let arquivoNacional = null;
  let erroNacional = null;

  try {
    arquivoNacional = await buscarJson(urlNacional, 10000);
  } catch (erro) {
    erroNacional = erro.message;
  }

  const consultas = await Promise.allSettled(
    UFS.map(uf => buscarResultadoEstadual(uf))
  );

  const estados = [];
  const listaFalhas = [];

  for (let i = 0; i < consultas.length; i++) {
    const resultado = consultas[i];

    if (resultado.status === "fulfilled") {
      estados.push(resultado.value);
    } else {
      listaFalhas.push({
        uf: UFS[i],
        erro: resultado.reason?.message || "Erro desconhecido"
      });
    }
  }

  const somar = campo =>
    estados.reduce(
      (total, estado) => total + (Number(estado[campo]) || 0),
      0
    );

  const totalSecoes = somar("secoesTotal");
  const secoesTotalizadas = somar("secoesTotalizadas");
  const totalEleitores = somar("eleitoradoApto");
  const eleitoresTotalizados = somar("eleitoradoTotalizado");

  const resposta = {
    ok: true,
    fonte: "TSE",
    eleicao: ELEICAO,
    turno: 2,
    consultadoEm: new Date().toISOString(),
    duracaoMs: Date.now() - inicio,

    nacionalDisponivel: Boolean(arquivoNacional),
    arquivoNacional: urlNacional,
    geracaoNacional: arquivoNacional?.idg ?? null,
    erroNacional,

    cobertura: {
      estadosConsultados: estados.length,
      estadosEsperados: 27,
      coberturaCompleta: estados.length === 27,
      falhas: listaFalhas,

      secoesTotal: totalSecoes,
      secoesTotalizadas,
      apuracaoSecoesPct: percentual(
        secoesTotalizadas,
        totalSecoes
      ),

      eleitoradoApto: totalEleitores,
      eleitoradoTotalizado: eleitoresTotalizados,
      apuracaoEleitoradoPct: percentual(
        eleitoresTotalizados,
        totalEleitores
      )
    },

    estados,

    observacao:
      "Consulta técnica dos arquivos estaduais do TSE. " +
      "Cobertura incompleta significa que os totais não representam " +
      "necessariamente todo o Brasil. Esta rota ainda não calcula " +
      "a projeção estatística municipal."
  };

  cache.brasil = resposta;
  cache.brasilEm = Date.now();

  return {
    ...resposta,
    cache: false
  };
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    servico: "Projeção Brasil — Coletor",
    eleicao: ELEICAO,
    endpoints: [
      "/api/status",
      "/api/brasil",
      "/api/municipios",
      "/api/diagnostico-municipios",
      "/api/municipio/UF/CODIGO"
    ]
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    servico: "Projeção Brasil — Coletor",
    fonte: "TSE",
    eleicao: ELEICAO,
    cacheMunicipioSegundos: 45,
    cacheBrasilSegundos: 25,
    horarioServidor: new Date().toISOString()
  });
});

app.get("/api/municipios", async (_req, res, next) => {
  try {
    const config = await obterConfiguracao();

    res.json({
      ok: true,
      fonte: "TSE",
      dataConfiguracao: config.data,
      horaConfiguracao: config.hora,
      geracaoConfiguracao: config.geracao,
      total: config.municipios.length,
      municipios: config.municipios
    });
  } catch (erro) {
    next(erro);
  }
});

app.get(
  "/api/diagnostico-municipios",
  async (_req, res, next) => {
    try {
      const config = await obterConfiguracao();
      const municipios = config.municipios;

      const codigos = municipios
        .map(m => m.codigo)
        .filter(Boolean);

      const codigosIBGE = municipios
        .map(m => m.codigoIBGE)
        .filter(Boolean);

      const contarUnicos = valores => new Set(valores).size;

      res.json({
        ok: true,
        dataConfiguracao: config.data,
        horaConfiguracao: config.hora,
        geracaoConfiguracao: config.geracao,
        registrosOriginais: municipios.length,
        codigosMunicipaisUnicos: contarUnicos(codigos),
        codigosMunicipaisRepetidos:
          codigos.length - contarUnicos(codigos),
        codigosIBGEUnicos: contarUnicos(codigosIBGE),
        codigosIBGERepetidos:
          codigosIBGE.length - contarUnicos(codigosIBGE),
        registrosSemIBGE:
          municipios.filter(m => !m.codigoIBGE).length,
        totalUFs: [
          ...new Set(municipios.map(m => m.uf))
        ].length,
        UFs: [
          ...new Set(municipios.map(m => m.uf))
        ]
      });
    } catch (erro) {
      next(erro);
    }
  }
);

app.get(
  "/api/municipio/:uf/:codigo",
  async (req, res, next) => {
    try {
      const uf = String(req.params.uf ?? "")
        .trim()
        .toLowerCase();

      const codigo = String(req.params.codigo ?? "")
        .trim()
        .padStart(5, "0");

      if (!UFS.includes(uf) || !/^\d{5}$/.test(codigo)) {
        return res.status(400).json({
          ok: false,
          erro: "UF ou código municipal inválido."
        });
      }

      const chave = `${uf}/${codigo}`;
      const armazenado = cache.municipios.get(chave);

      if (
        armazenado &&
        Date.now() - armazenado.em < 45000
      ) {
        return res.json({
          ...armazenado.dados,
          cache: true
        });
      }

      const url =
        `${BASE}/dados/${uf}/${uf}${codigo}-c0001-e${ELEICAO}-u.json`;

      const dados = await buscarJson(url);
      const config = await obterConfiguracao();

      const municipio = config.municipios.find(
        m => m.uf === uf && m.codigo === codigo
      );

      const resultado = {
        ok: true,
        fonte: "TSE",
        eleicao: ELEICAO,
        turno: 2,
        uf,
        codigo,
        municipio: municipio?.nome || codigo,
        codigoIBGE: municipio?.codigoIBGE || null,
        arquivo: url,
        consultadoEm: new Date().toISOString(),
        geracao: dados?.idg ?? null,
        dados
      };

      cache.municipios.set(chave, {
        em: Date.now(),
        dados: resultado
      });

      res.json({
        ...resultado,
        cache: false
      });
    } catch (erro) {
      next(erro);
    }
  }
);

app.get("/api/brasil", async (_req, res, next) => {
  try {
    res.json(await obterBrasil());
  } catch (erro) {
    next(erro);
  }
});

app.use((erro, _req, res, _next) => {
  console.error("Erro no coletor:", erro);

  res.status(erro.status || 502).json({
    ok: false,
    erro: erro.message || "Falha inesperada no coletor.",
    horarioServidor: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(
    `Projeção Brasil coletor ouvindo na porta ${PORT}`
  );
});
