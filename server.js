
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({
    ok: true,
    servico: "Projeção Brasil — Coletor",
    mensagem: "Servidor ativo"
  });
});

app.get("/api/diagnostico", async (req, res) => {
  const url =
    "https://resultados.tse.jus.br/oficial/ele2026/6258/dados/br/br-c0001-e006258-u.json";

  try {
    const resposta = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0"
      },
      signal: AbortSignal.timeout(15000)
    });

    const texto = await resposta.text();

    res.status(200).json({
      ok: resposta.ok,
      statusOrigem: resposta.status,
      tipoConteudo: resposta.headers.get("content-type"),
      amostra: texto.slice(0, 500),
      consultadoEm: new Date().toISOString()
    });
  } catch (erro) {
    res.status(200).json({
      ok: false,
      erro: String(erro),
      consultadoEm: new Date().toISOString()
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
