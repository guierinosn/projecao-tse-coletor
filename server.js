
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

// Totalização presidencial do exterior (abrangência ZZ).
// É usada apenas na projeção baseada em localidades; o arquivo BR oficial
// já agrega o exterior e não deve receber esta soma novamente.
const URL_EXTERIOR_PRESIDENTE =
  `${BASE}/dados/zz/zz-c0001-e${ELEICAO_ARQ}-u.json`;

const cache = {
  config: null,
  configAt: 0,
  national: null,
  nationalAt: 0,
  municipalities: new Map(),
  exterior: null,
  exteriorAt: 0,
  exteriorError: null,
  refreshStarted: false,
  refreshStatus: "Aguardando inicialização"
};

const CACHE_MS = 25000;
const MUNICIPIO_CACHE_MS = 300000;
const EXTERIOR_CACHE_MS = 60000;

// As credenciais ficam somente nas variáveis privadas do Render.
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const HISTORICO_INTERVAL_MS = 60000;
let ultimoSnapshotHash = "";
let historicoUltimoErro = null;
let historicoUltimaGravacao = null;
let historicoLoopIniciado = false;
let cicloHistoricoEmAndamento = false;

function supabaseConfigurado() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

async function supabaseRequest(path, options = {}) {
  if (!supabaseConfigurado()) {
    throw new Error(
      "Supabase não configurado: verifique SUPABASE_URL e " +
      "SUPABASE_SERVICE_ROLE_KEY no Render."
    );
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...options.headers
    }
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase HTTP ${response.status}: ${body.slice(0, 500)}`
    );
  }

  return body ? JSON.parse(body) : null;
}

async function gravarSnapshot(dados) {
  if (!supabaseConfigurado()) {
    return {
      salvo: false,
      motivo: "Supabase não configurado"
    };
  }

  const oficial = dados.oficial || dados.brasil?.oficial || null;
  const candidatosOficiais =
    dados.candidatosOficiais || dados.brasil?.candidatosOficiais || [];

  // Não grava snapshots idênticos consecutivos.
  const assinatura = JSON.stringify({
    eleicao: dados.eleicao,
    oficial: oficial ? {
      geracao: oficial.geracao,
      secoesTotalizadas: oficial.secoesTotalizadas,
      eleitoradoTotalizado: oficial.eleitoradoTotalizado,
      votosValidos: oficial.votosValidos,
      votosBrancos: oficial.votosBrancos,
      votosNulos: oficial.votosNulos,
      candidatos: candidatosOficiais
    } : null,
    projecao: dados.projecao ? {
      apuracaoVotosPct: dados.projecao.apuracaoVotosPct,
      votosApurados: dados.projecao.votosApurados,
      votosFinaisProjetados: dados.projecao.votosFinaisProjetados,
      votosValidosProjetados: dados.projecao.votosValidosProjetados,
      candidatos: dados.projecao.candidatos
    } : null
  });

  if (assinatura === ultimoSnapshotHash) {
    return {
      salvo: false,
      motivo: "Dados sem alterações",
      ultimaGravacao: historicoUltimaGravacao
    };
  }

  await supabaseRequest("historico_apuracao", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([{
      eleicao: String(dados.eleicao || ELEICAO),
      origem: "TSE",
      dados
    }])
  });

  ultimoSnapshotHash = assinatura;
  historicoUltimaGravacao = new Date().toISOString();
  historicoUltimoErro = null;

  return {
    salvo: true,
    registradoEm: historicoUltimaGravacao
  };
}

async function obterResultadoExterior() {
  if (cache.exterior && Date.now() - cache.exteriorAt < EXTERIOR_CACHE_MS) {
    return cache.exterior;
  }

  try {
    const data = await buscarJson(URL_EXTERIOR_PRESIDENTE, 10000);
    const result = {
      ...resumir(data, "zz"),
      codigo: "ZZ",
      codigoIBGE: "",
      municipio: "Exterior",
      arquivo: URL_EXTERIOR_PRESIDENTE
    };

    // Só aceitamos a resposta se ela tiver a estrutura esperada.
    if (!result.eleitoradoApto && !result.secoesTotal && !result.candidatos.length) {
      throw new Error("O arquivo ZZ não contém estatísticas reconhecíveis.");
    }

    cache.exterior = result;
    cache.exteriorAt = Date.now();
    cache.exteriorError = null;
    return result;
  } catch (e) {
    cache.exteriorError = e.message || String(e);
    console.error("Falha ao consultar totalização presidencial do exterior:", cache.exteriorError);
    // Se já houve uma resposta válida, mantém o último valor enquanto a fonte falha.
    return cache.exterior || null;
  }
}

async function obterProjecaoAtual() {
  const c = await obterConfiguracao();

  const rows = c.municipios
    .map(m => cache.municipalities.get(`${m.uf}/${m.codigo}`)?.data)
    .filter(Boolean);

  // ZZ não é município brasileiro. É uma localidade separada, incluída
  // apenas na projeção presidencial quando o arquivo oficial estiver disponível.
  const exterior = await obterResultadoExterior();
  const rowsParaProjecao = exterior ? [...rows, exterior] : rows;
  const estadosProjetados = UFS.map(uf => {
    const municipaisUf = rows.filter(m => m.uf === uf);
    const municipiosUf = c.municipios.filter(m => m.uf === uf);
    const resumo = projetarMunicipios(municipaisUf, municipiosUf.length);
    return {
      uf,
      estado: NOMES_UF[uf] || uf.toUpperCase(),
      municipiosComDados: resumo.municipiosComDados,
      eleitoradoAptoComDados: resumo.eleitoradoApto,
      eleitoradoTotalizado: resumo.eleitoradoTotalizado,
      votosApurados: resumo.votosApurados,
      votosFinaisProjetados: resumo.votosFinaisProjetados,
      apuracaoVotosPct: resumo.apuracaoVotosPct,
      candidatos: resumo.candidatos
    };
  });
  const projecao = projetarMunicipios(rowsParaProjecao, c.municipios.length);
  projecao.estadosProjetados = estadosProjetados;

  return {
    calculadoEm: new Date().toISOString(),
    carga: {
      status: cache.refreshStatus,
      emAndamento: cache.refreshStarted,
      municipiosCarregados: rows.length,
      municipiosConfigurados: c.municipios.length,
      exteriorDisponivel: Boolean(exterior),
      exteriorEleitoradoApto: exterior?.eleitoradoApto ?? null,
      exteriorArquivo: URL_EXTERIOR_PRESIDENTE,
      exteriorErro: cache.exteriorError
    },
    projecao
  };
}

async function cicloHistorico() {
  if (!supabaseConfigurado() || cicloHistoricoEmAndamento) return;

  cicloHistoricoEmAndamento = true;

  try {
    const brasil = await obterBrasil();
    const proj = await obterProjecaoAtual();

    const resultado = await gravarSnapshot({
      eleicao: ELEICAO,
      consultadoEm: new Date().toISOString(),
      fonte: "TSE",
      brasil,
      ...proj
    });

    if (resultado.salvo) {
      console.log(
        "Snapshot do histórico gravado:",
        resultado.registradoEm
      );
    }
  } catch (e) {
    historicoUltimoErro = e.message || String(e);
    console.error("Falha ao gravar histórico:", historicoUltimoErro);
  } finally {
    cicloHistoricoEmAndamento = false;
  }
}

function iniciarHistorico() {
  if (historicoLoopIniciado) return;

  historicoLoopIniciado = true;
  cicloHistorico();

  setInterval(cicloHistorico, HISTORICO_INTERVAL_MS);
}

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
  if (
    !root ||
    typeof root !== "object" ||
    depth > 14 ||
    seen.has(root)
  ) return;

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

      if (!old || item.votos > old.votos) {
        map.set(key, item);
      }
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

  cache.municipalities.set(key, {
    at: Date.now(),
    data: result
  });

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
  // A projeção usa votos observados por eleitorado das seções já totalizadas.
  // Seções/urnas nunca entram na fórmula de cobertura de votos.
  const usable = rows.filter(m => m && m.eleitoradoApto > 0);
  const observed = usable.filter(m =>
    m.eleitoradoTotalizado > 0 &&
    (m.votosValidos + m.votosBrancos + m.votosNulos) > 0
  );

  const aggregate = list => {
    const electorate = list.reduce((s,m)=>s + Math.max(0,m.eleitoradoTotalizado||0),0);
    const ballots = list.reduce((s,m)=>s + Math.max(0,(m.votosValidos||0)+(m.votosBrancos||0)+(m.votosNulos||0)),0);
    const valid = list.reduce((s,m)=>s + Math.max(0,m.votosValidos||0),0);
    const white = list.reduce((s,m)=>s + Math.max(0,m.votosBrancos||0),0);
    const nul = list.reduce((s,m)=>s + Math.max(0,m.votosNulos||0),0);
    const candidateVotes = new Map();
    for (const m of list) for (const c of (m.candidatos||[])) {
      const key = c.numero || c.nome;
      const old = candidateVotes.get(key) || {numero:c.numero,nome:c.nome,partido:c.partido,votos:0};
      old.votos += Math.max(0,c.votos||0);
      candidateVotes.set(key,old);
    }
    const candTotal = [...candidateVotes.values()].reduce((s,c)=>s+c.votos,0);
    return {
      electorate, ballots, valid, white, nul,
      turnout: electorate > 0 ? Math.min(1,ballots/electorate) : null,
      validShare: ballots > 0 ? valid/ballots : null,
      whiteShare: ballots > 0 ? white/ballots : null,
      nullShare: ballots > 0 ? nul/ballots : null,
      candidateShares: new Map([...candidateVotes].map(([k,c])=>[k,{
        ...c, share: candTotal>0?c.votos/candTotal:0
      }]))
    };
  };

  const nationalObserved = aggregate(observed);
  const byUf = new Map();
  for (const uf of UFS) byUf.set(uf, aggregate(observed.filter(m=>m.uf===uf)));
  const fallbackTurnout = nationalObserved.turnout;
  const fallbackValid = nationalObserved.validShare;
  const fallbackWhite = nationalObserved.whiteShare;
  const fallbackNull = nationalObserved.nullShare;
  const fallbackCandidates = nationalObserved.candidateShares;

  let eligible = 0, electorateWithResults = 0;
  let officialValid = 0, officialWhite = 0, officialNull = 0;
  let projectedBallots = 0, projectedValid = 0, projectedWhite = 0, projectedNull = 0;
  let projectedAbstention = 0, observedBallots = 0, municipalitiesWithVotes = 0;
  let totalSections = 0, countedSections = 0;
  const byCandidate = new Map();
  let exteriorComDados = false;

  for (const m of usable) {
    const apto = Math.max(0,m.eleitoradoApto||0);
    const eTotalizado = Math.max(0,m.eleitoradoTotalizado||0);
    const valid = Math.max(0,m.votosValidos||0);
    const white = Math.max(0,m.votosBrancos||0);
    const nul = Math.max(0,m.votosNulos||0);
    const ballots = valid + white + nul;
    eligible += apto;
    electorateWithResults += eTotalizado;
    totalSections += Math.max(0,m.secoesTotal||0);
    countedSections += Math.max(0,m.secoesTotalizadas||0);
    officialValid += valid; officialWhite += white; officialNull += nul;
    observedBallots += ballots;

    const hasLocal = eTotalizado > 0 && ballots > 0 && (m.candidatos||[]).length > 0;
    if (hasLocal) {
      if (m.uf === 'zz') exteriorComDados = true;
      else municipalitiesWithVotes++;
    }

    const ufStats = byUf.get(m.uf);
    const turnout = hasLocal
      ? Math.min(1, ballots / eTotalizado)
      : (ufStats?.turnout ?? fallbackTurnout);
    const validShare = hasLocal
      ? (ballots > 0 ? valid / ballots : fallbackValid)
      : (ufStats?.validShare ?? fallbackValid);
    const whiteShare = hasLocal
      ? (ballots > 0 ? white / ballots : fallbackWhite)
      : (ufStats?.whiteShare ?? fallbackWhite);
    const nullShare = hasLocal
      ? (ballots > 0 ? nul / ballots : fallbackNull)
      : (ufStats?.nullShare ?? fallbackNull);
    const candidateShares = hasLocal
      ? new Map((m.candidatos||[]).map(c=>[c.numero||c.nome,{
          numero:c.numero,nome:c.nome,partido:c.partido,
          share:(m.candidatos||[]).reduce((sum,x)=>sum+Math.max(0,x.votos||0),0)>0
            ? Math.max(0,c.votos||0)/(m.candidatos||[]).reduce((sum,x)=>sum+Math.max(0,x.votos||0),0) : 0
        }]))
      : ((ufStats?.candidateShares?.size ? ufStats.candidateShares : fallbackCandidates) || new Map());

    // Se ainda não há qualquer resultado no país, não há base estatística para projetar.
    if (turnout === null || validShare === null || !candidateShares.size) continue;
    const ballotsFinal = apto * turnout;
    const validFinal = ballotsFinal * validShare;
    const whiteFinal = ballotsFinal * (whiteShare ?? 0);
    const nullFinal = ballotsFinal * (nullShare ?? 0);
    projectedBallots += ballotsFinal;
    projectedValid += validFinal;
    projectedWhite += whiteFinal;
    projectedNull += nullFinal;
    projectedAbstention += Math.max(0,apto-ballotsFinal);

    for (const [key,share] of candidateShares) {
      const old = byCandidate.get(key) || {
        numero:share.numero, nome:share.nome, partido:share.partido,
        votosOficiais:0, votosProjetados:0
      };
      const localCandidate = (m.candidatos||[]).find(c=>(c.numero||c.nome)===key);
      if (localCandidate) old.votosOficiais += Math.max(0,localCandidate.votos||0);
      old.votosProjetados += validFinal * Math.max(0,share.share||0);
      byCandidate.set(key,old);
    }
  }

  const candidates = [...byCandidate.values()].sort((a,b)=>b.votosProjetados-a.votosProjetados);
  const candidateTotal = candidates.reduce((s,c)=>s+c.votosProjetados,0);
  for (const c of candidates) c.percentualProjetado = pct(c.votosProjetados,candidateTotal);

  return {
    eleitoradoApto: eligible,
    eleitoradoTotalizado: electorateWithResults,
    apuracaoEleitoradoPct: pct(electorateWithResults,eligible), // informativo; não é avanço da projeção
    votosApurados: observedBallots,
    votosFinaisProjetados: projectedBallots,
    apuracaoVotosPct: projectedBallots > 0 ? Math.min(100,pct(observedBallots,projectedBallots)) : null,
    secoesTotal: totalSections,
    secoesTotalizadas: countedSections,
    apuracaoSecoesPct: pct(countedSections,totalSections), // apenas diagnóstico operacional
    votosValidosOficiais: officialValid,
    votosBrancosOficiais: officialWhite,
    votosNulosOficiais: officialNull,
    votosValidosProjetados: projectedValid,
    votosBrancosProjetados: projectedWhite,
    votosNulosProjetados: projectedNull,
    abstencoesProjetadas: projectedAbstention,
    candidatos: candidates,
    municipiosConfigurados: totalConfigurado,
    municipiosComDados: municipalitiesWithVotes,
    municipiosPendentes: Math.max(0,totalConfigurado-municipalitiesWithVotes),
    exteriorComDados,
    metodo: "Projeção municipal por taxa de comparecimento e composição de votos observadas; localidades sem resultados usam a média estadual e, quando indisponível, nacional.",
    observacao: "A cobertura de apuração é votos apurados divididos pelo total de votos finais estimado. Urnas e seções não entram nessa fórmula. Estimativas preliminares não são resultados oficiais."
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

      return {
        ...resumir(data, uf),
        arquivo: url
      };
    }))
  ]);

  const trackingData =
    tracking.status === "fulfilled" ? tracking.value : null;

  const presidentData =
    president.status === "fulfilled" ? president.value : null;

  const estados = [];
  const falhasEstados = [];

  stateResults.forEach((r, i) => {
    if (r.status === "fulfilled") {
      estados.push(r.value);
    } else {
      falhasEstados.push({
        uf: UFS[i],
        erro: r.reason?.message || "Falha na consulta"
      });
    }
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
      resultadoPresidencialExterior: URL_EXTERIOR_PRESIDENTE,
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
      "/api/historico",
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
    cargaMunicipal: cache.refreshStatus,
    exterior: {
      arquivo: URL_EXTERIOR_PRESIDENTE,
      disponivel: Boolean(cache.exterior),
      eleitoradoApto: cache.exterior?.eleitoradoApto ?? null,
      erro: cache.exteriorError
    },
    historico: {
      configurado: supabaseConfigurado(),
      ultimaGravacao: historicoUltimaGravacao,
      ultimoErro: historicoUltimoErro
    }
  });
});

app.get("/api/historico", async (req, res, next) => {
  try {
    if (!supabaseConfigurado()) {
      return res.status(503).json({
        ok: false,
        erro: "Supabase não configurado no Render."
      });
    }

    const rawLimit = Number.parseInt(
      String(req.query.limit || "100"),
      10
    );

    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(500, rawLimit))
      : 100;

    const rows = await supabaseRequest(
      `historico_apuracao?select=id,eleicao,registrado_em,origem,dados` +
      `&eleicao=eq.${encodeURIComponent(ELEICAO)}` +
      `&order=registrado_em.desc&limit=${limit}`,
      { method: "GET" }
    );

    res.json({
      ok: true,
      total: rows.length,
      historicoDisponivel: rows.length > 0,
      registros: rows
    });
  } catch (e) {
    next(e);
  }
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
    const m = c.municipios.find(
      x => x.uf === uf && x.codigo === codigo
    );

    if (!m) {
      return res.status(404).json({
        ok: false,
        erro: "Município não encontrado na configuração do TSE"
      });
    }

    res.json({
      ok: true,
      ...await obterResultadoMunicipal(m)
    });
  } catch (e) {
    next(e);
  }
});

app.get("/api/projecao", async (_req, res, next) => {
  try {
    const c = await obterConfiguracao();

    if (
      !cache.refreshStarted &&
      cache.municipalities.size < c.municipios.length
    ) {
      atualizarCacheMunicipal();
    }

    const atual = await obterProjecaoAtual();

    const payload = {
      ok: true,
      fonte: "TSE",
      eleicao: ELEICAO,
      calculadoEm: atual.calculadoEm,
      carga: atual.carga,
      projecao: atual.projecao,
      historicoDisponivel: null,
      observacao:
        "Estimativa preliminar baseada nos municípios com dados válidos. " +
        "Municípios sem dados não recebem votos inventados. " +
        "A projeção não deve ser interpretada como resultado oficial."
    };

    try {
      const gravacao = await gravarSnapshot({
        eleicao: ELEICAO,
        consultadoEm: new Date().toISOString(),
        fonte: "TSE",
        projecao: atual.projecao,
        carga: atual.carga
      });

      payload.historicoDisponivel =
        gravacao.salvo || historicoUltimaGravacao !== null;

      payload.historicoGravacao = gravacao;
    } catch (e) {
      historicoUltimoErro = e.message || String(e);
      payload.historicoDisponivel = false;
      payload.erroHistorico = historicoUltimoErro;
    }

    res.json(payload);
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

  // Inicia a carga municipal e a gravação do histórico em segundo plano.
  atualizarCacheMunicipal();
  iniciarHistorico();
});
