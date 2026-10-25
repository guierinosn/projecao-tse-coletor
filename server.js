// Totalização presidencial do exterior (abrangência ZZ).
const URL_EXTERIOR_PRESIDENTE =
  `${BASE}/dados/zz/zz-c0001-e${ELEICAO_ARQ}-u.json`;

async function obterResultadoExterior() {
  try {
    const data = await buscarJson(URL_EXTERIOR_PRESIDENTE);
    const resultado = resumir(data, "zz");

    return {
      ...resultado,
      municipio: "Exterior",
      arquivo: URL_EXTERIOR_PRESIDENTE
    };
  } catch (e) {
    console.error(
      "Falha ao consultar totalização presidencial do exterior:",
      e.message
    );

    return null;
  }
}
