import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI } from "@google/genai";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const fontkit = require("fontkit");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FISH_API_KEY = process.env.FISH_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const MODELO_GEMINI = "gemini-flash-latest";
const MODELO_FISH = "s2.1-pro";
const VELOCIDADE_VOZ = 1.1;
const FONTE_HEADLINE = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const FONTE_CARREGADA = fontkit.openSync(FONTE_HEADLINE);

const FATOR_VELOCIDADE_MIN = 0.85;
const FATOR_VELOCIDADE_MAX = 1.15;

// ---------- Medição real de texto ----------

function medirLarguraTexto(texto, fontsize) {
  const run = FONTE_CARREGADA.layout(texto);
  return (run.advanceWidth / FONTE_CARREGADA.unitsPerEm) * fontsize;
}

function quebrarTextoPorLarguraReal(texto, fontsize, larguraMaximaPx) {
  const palavras = texto.split(" ");
  const linhas = [];
  let linhaAtual = "";
  for (const palavra of palavras) {
    const tentativa = linhaAtual ? `${linhaAtual} ${palavra}` : palavra;
    if (medirLarguraTexto(tentativa, fontsize) > larguraMaximaPx && linhaAtual) {
      linhas.push(linhaAtual);
      linhaAtual = palavra;
    } else {
      linhaAtual = tentativa;
    }
  }
  if (linhaAtual) linhas.push(linhaAtual);
  return linhas;
}

// Reduz a fonte progressivamente até o texto caber em no máximo 2 linhas
function ajustarParaDuasLinhas(texto, larguraMaximaPx, fontsizeInicial, fontsizeMinimo = 20) {
  let fontsize = fontsizeInicial;
  let linhas = quebrarTextoPorLarguraReal(texto, fontsize, larguraMaximaPx);
  while (linhas.length > 2 && fontsize > fontsizeMinimo) {
    fontsize -= 2;
    linhas = quebrarTextoPorLarguraReal(texto, fontsize, larguraMaximaPx);
  }
  return { fontsize, linhas };
}

// ---------- Dicionário de correção de pronúncia (vem do Supabase) ----------

async function buscarDicionarioPronuncia() {
  const { data, error } = await supabase
    .from("pronuncia_correcoes")
    .select("palavra_errada, palavra_corrigida");

  if (error) {
    console.error("Erro ao buscar dicionário de pronúncia:", error.message);
    return {};
  }

  const dicionario = {};
  for (const linha of data) {
    dicionario[linha.palavra_errada.toLowerCase()] = linha.palavra_corrigida;
  }
  return dicionario;
}

function corrigirPronuncia(texto, dicionario) {
  let corrigido = texto;
  for (const [errada, certa] of Object.entries(dicionario)) {
    const regex = new RegExp(`\\b${errada}\\b`, "gi");
    corrigido = corrigido.replace(regex, (match) => {
      if (match[0] === match[0].toUpperCase()) {
        return certa.charAt(0).toUpperCase() + certa.slice(1);
      }
      return certa;
    });
  }
  return corrigido;
}

// ---------- Helpers ----------

function duracaoAudio(p) {
  const saida = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`
  ).toString().trim();
  return parseFloat(saida);
}

function larguraVideo(p) {
  const saida = execSync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=width -of default=noprint_wrappers=1:nokey=1 "${p}"`
  ).toString().trim();
  return parseInt(saida, 10);
}

function paraSentenceCase(texto) {
  const m = texto.toLowerCase();
  return m.charAt(0).toUpperCase() + m.slice(1);
}

function escaparParaDrawtext(texto) {
  return texto.replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/,/g, "\\,");
}

function clamp(valor, min, max) {
  return Math.min(Math.max(valor, min), max);
}

// ---------- Etapa 1: Gemini analisa e segmenta ----------

async function analisarVideo(videoPath) {
  const uploaded = await ai.files.upload({ file: videoPath, config: { mimeType: "video/mp4" } });
  let file = uploaded;
  while (file.state === "PROCESSING") {
    await new Promise((r) => setTimeout(r, 2000));
    file = await ai.files.get({ name: uploaded.name });
  }
  if (file.state === "FAILED") throw new Error("Gemini falhou ao processar o vídeo");

  const prompt = `
Analise este vídeo de produto com atenção aos CORTES DE CENA (mudanças de plano/ângulo/cena).

Responda APENAS com um JSON válido, sem markdown, no formato exato abaixo:

{
  "description": "descrição completa do vídeo",
  "headline": "chamada curta e IMPACTANTE para sobrepor no vídeo (máx 10 palavras)",
  "cta_keyword": "uma única palavra ou expressão bem curta relacionada ao produto, simples de digitar em um comentário",
  "cenas": [
    { "inicio_seg": 0, "fim_seg": 4.5, "narracao": "texto de narração SÓ para esse trecho" }
  ]
}

REGRAS PARA A HEADLINE — siga rigorosamente este estilo (curiosidade, benefício direto, um pouco de humor/exagero). Varie a estrutura da frase a cada vídeo, não repita sempre o mesmo formato:
- "Essa sapateira é a cara da riqueza com preço de Shopee"
- "Barbeador que deixa pele de neném"
- "O spray que recupera farol amarelado"
- "Adeus sofrimento para tirar cravos"
NÃO use headlines genéricas do tipo "Limpe tudo sem esforço com essa escova" — prefira sempre o ângulo de curiosidade/benefício acima.

REGRAS PARA AS NARRAÇÕES DAS CENAS:
- Calibre cada narração de cena para caber em (fim_seg - inicio_seg) segundos usando uma cadência de aproximadamente 3,2 palavras por segundo. Escreva o texto mais completo possível dentro desse limite — é melhor a narração ficar um pouco mais longa do que curta demais.
- Identifique os cortes de cena reais (mudança de plano/ângulo) e use timestamps em segundos.
- A ÚLTIMA cena deve terminar EXATAMENTE com: Comente "CTA_KEYWORD" que eu te envio o link! — usando o valor de cta_keyword, sempre com ponto de exclamação no final.
`.trim();

  const response = await ai.models.generateContent({
    model: MODELO_GEMINI,
    contents: [{ role: "user", parts: [{ fileData: { fileUri: file.uri, mimeType: file.mimeType } }, { text: prompt }] }],
  });

  await ai.files.delete({ name: uploaded.name });

  const limpo = response.text.replace(/```json|```/g, "").trim();
  return JSON.parse(limpo);
}

// ---------- Etapa 2: Fish Audio gera a narração de cada cena ----------

async function gerarAudioCena(texto, voiceId, outPath, dicionario) {
  const textoCorrigido = corrigirPronuncia(texto, dicionario);
  const resp = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: { Authorization: `Bearer ${FISH_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: textoCorrigido,
      reference_id: voiceId,
      format: "mp3",
      model: MODELO_FISH,
      prosody: { speed: VELOCIDADE_VOZ, volume: 0 },
    }),
  });
  if (!resp.ok) throw new Error(`Fish Audio falhou: ${await resp.text()}`);
  fs.writeFileSync(outPath, Buffer.from(await resp.arrayBuffer()));
}

// ---------- Etapa 3: FFmpeg monta o vídeo final ----------

function montarVideoFinal({ videoPath, watermarkPath, audiosPaths, cenas, headline, outPath }) {
  const duracoesAudio = audiosPaths.map((p) => duracaoAudio(p));
  const larguraVideoPx = larguraVideo(videoPath);

  const infoCenas = cenas.map((cena, i) => {
    const duracaoVideoOriginal = cena.fim_seg - cena.inicio_seg;
    const fatorIdeal = duracoesAudio[i] / duracaoVideoOriginal;
    const fator = clamp(fatorIdeal, FATOR_VELOCIDADE_MIN, FATOR_VELOCIDADE_MAX);
    const duracaoFinalCena = duracaoVideoOriginal * fator;
    if (fatorIdeal !== fator) {
      console.log(
        `  Cena ${i + 1}: fator ideal ${fatorIdeal.toFixed(2)}x fora da faixa segura, limitado para ${fator.toFixed(2)}x`
      );
    }
    return { ...cena, fator, duracaoFinalCena };
  });

  const trims = infoCenas
    .map((cena, i) => `[0:v]trim=start=${cena.inicio_seg}:end=${cena.fim_seg},setpts=(PTS-STARTPTS)*${cena.fator}[vseg${i}]`)
    .join(";");

  const audioProcessado = infoCenas
    .map((cena, i) => {
      const dur = cena.duracaoFinalCena.toFixed(3);
      return `[${i + 2}:a]atrim=0:${dur},apad=whole_dur=${dur}[aseg${i}]`;
    })
    .join(";");

  const n = cenas.length;
  const vConcat = infoCenas.map((_, i) => `[vseg${i}]`).join("");
  const aConcat = infoCenas.map((_, i) => `[aseg${i}]`).join("");

  const fontsizeInicial = Math.round(clamp(larguraVideoPx * 0.052, 26, 46));
  const larguraMaximaTexto = larguraVideoPx * 0.85;

  const { fontsize: fontsizeHeadline, linhas } = ajustarParaDuasLinhas(
    paraSentenceCase(headline),
    larguraMaximaTexto,
    fontsizeInicial
  );

  const larguraMaiorLinha = Math.max(...linhas.map((l) => medirLarguraTexto(l, fontsizeHeadline)));

  const boxY = 110, boxPadX = 24, boxPadY = 18, lineHeight = fontsizeHeadline + 12;
  const boxWidth = Math.min(larguraVideoPx * 0.94, larguraMaiorLinha + boxPadX * 2);
  const boxHeight = linhas.length * lineHeight + boxPadY * 1.2;

  const drawbox = `drawbox=x=(iw-${boxWidth.toFixed(0)})/2:y=${boxY}:w=${boxWidth.toFixed(0)}:h=${boxHeight.toFixed(0)}:color=white@1.0:t=fill`;
  const drawtexts = linhas
    .map((linha, i) => {
      const y = boxY + boxPadY + i * lineHeight;
      return `drawtext=fontfile='${FONTE_HEADLINE}':text='${escaparParaDrawtext(linha)}':fontcolor=black:fontsize=${fontsizeHeadline}:x=(w-text_w)/2:y=${y}`;
    })
    .join(",");

  const filterComplex = [
    trims,
    audioProcessado,
    `${vConcat}concat=n=${n}:v=1:a=0[vconcat]`,
    `${aConcat}concat=n=${n}:v=0:a=1[aout]`,
    `[1:v]scale=240:-1[wm]`,
    `[vconcat][wm]overlay=(W-w)/2:H-h-30[vwm]`,
    `[vwm]${drawbox},${drawtexts}[vout]`,
  ].join(";");

  const inputs = [`-i "${videoPath}"`, `-i "${watermarkPath}"`, ...audiosPaths.map((a) => `-i "${a}"`)];
  const cmd = `ffmpeg -y ${inputs.join(" ")} -filter_complex "${filterComplex}" -map "[vout]" -map "[aout]" -c:v libx264 -c:a aac -shortest "${outPath}"`;
  execSync(cmd, { stdio: "inherit" });
}

// ---------- Orquestração do job ----------

async function processarJob(job) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-"));
  try {
    console.log(`Processando job ${job.id}...`);

    const { data: preset } = await supabase.from("brand_presets").select("*").eq("id", job.preset_id).single();
    const dicionarioPronuncia = await buscarDicionarioPronuncia();

    const videoPath = path.join(tmpDir, "original.mp4");
    const { data: videoBlob } = await supabase.storage.from("videos-originais").download(job.video_original_path);
    fs.writeFileSync(videoPath, Buffer.from(await videoBlob.arrayBuffer()));

    const watermarkPath = path.join(tmpDir, "watermark.png");
    const { data: wmBlob } = await supabase.storage.from("marcas-dagua").download(preset.watermark_path);
    fs.writeFileSync(watermarkPath, Buffer.from(await wmBlob.arrayBuffer()));

    const geminiJson = await analisarVideo(videoPath);
    await supabase.from("video_jobs").update({ status: "narrating", gemini_json: geminiJson }).eq("id", job.id);
    await supabase.from("job_events").insert({ job_id: job.id, etapa: "gemini_ok", payload: geminiJson });

    const audiosPaths = [];
    for (let i = 0; i < geminiJson.cenas.length; i++) {
      const p = path.join(tmpDir, `cena_${i}.mp3`);
      await gerarAudioCena(geminiJson.cenas[i].narracao, preset.voice_id, p, dicionarioPronuncia);
      audiosPaths.push(p);
    }
    await supabase.from("video_jobs").update({ status: "rendering" }).eq("id", job.id);

    const outPath = path.join(tmpDir, "final.mp4");
    montarVideoFinal({
      videoPath,
      watermarkPath,
      audiosPaths,
      cenas: geminiJson.cenas,
      headline: geminiJson.headline,
      outPath,
    });

    const finalStoragePath = `${job.id}.mp4`;
    const buffer = fs.readFileSync(outPath);
    await supabase.storage.from("videos-finais").upload(finalStoragePath, buffer, { contentType: "video/mp4", upsert: true });

    await supabase.from("video_jobs").update({ status: "done", video_final_path: finalStoragePath }).eq("id", job.id);
    console.log(`Job ${job.id} concluído.`);
  } catch (err) {
    console.error(`Job ${job.id} falhou:`, err.message);
    await supabase.from("video_jobs").update({ status: "failed", erro: err.message }).eq("id", job.id);
    await supabase.from("job_events").insert({ job_id: job.id, etapa: "erro", payload: { mensagem: err.message } });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function loopPrincipal() {
  console.log(`[${new Date().toISOString()}] Verificando fila...`);
  const { data: jobs, error } = await supabase.rpc("pegar_proximo_job");
  if (error) {
    console.error("Erro ao buscar job:", error.message, error.details, error.hint);
  } else if (jobs && jobs.length > 0) {
    console.log(`Job encontrado: ${jobs[0].id}`);
    await processarJob(jobs[0]);
  } else {
    console.log("Nenhum job pendente.");
  }
  setTimeout(loopPrincipal, 5000);
}

console.log("Worker iniciado, aguardando jobs...");
loopPrincipal();
