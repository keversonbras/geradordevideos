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
const MAX_TENTATIVAS_NARRACAO = 3;
const TOLERANCIA_SEGUNDOS = 0.4;
const COR_CHROMA = "0x00FF00";

const INSTRUCOES_ESTILO_PADRAO =
  "Escreva a narração com tom de curiosidade e benefício direto, com um pouco de humor/exagero.";

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

function ajustarParaDuasLinhas(texto, larguraMaximaPx, fontsizeInicial, fontsizeMinimo = 20) {
  let fontsize = fontsizeInicial;
  let linhas = quebrarTextoPorLarguraReal(texto, fontsize, larguraMaximaPx);
  while (linhas.length > 2 && fontsize > fontsizeMinimo) {
    fontsize -= 2;
    linhas = quebrarTextoPorLarguraReal(texto, fontsize, larguraMaximaPx);
  }
  return { fontsize, linhas };
}

// ---------- Dicionário de correção de pronúncia ----------

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

// ---------- Busca as instruções do estilo de narração escolhido ----------

async function buscarInstrucoesEstilo(estiloId) {
  if (!estiloId) return INSTRUCOES_ESTILO_PADRAO;
  const { data, error } = await supabase
    .from("estilos_narracao")
    .select("instrucoes")
    .eq("id", estiloId)
    .single();
  if (error || !data) {
    console.error("Erro ao buscar estilo de narração, usando padrão:", error?.message);
    return INSTRUCOES_ESTILO_PADRAO;
  }
  return data.instrucoes;
}

// ---------- Helpers ----------

function duracaoAudio(p) {
  const saida = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`
  ).toString().trim();
  return parseFloat(saida);
}

function duracaoVideoTotal(p) {
  return duracaoAudio(p);
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

// ---------- Etapa 1: Gemini analisa o vídeo e gera narração ----------

async function analisarVideo(videoPath, instrucoesEstilo) {
  const uploaded = await ai.files.upload({ file: videoPath, config: { mimeType: "video/mp4" } });
  let file = uploaded;
  while (file.state === "PROCESSING") {
    await new Promise((r) => setTimeout(r, 2000));
    file = await ai.files.get({ name: uploaded.name });
  }
  if (file.state === "FAILED") throw new Error("Gemini falhou ao processar o vídeo");

  const prompt = `
Analise este vídeo de produto.

Responda APENAS com um JSON válido, sem markdown, no formato exato abaixo:

{
  "description": "descrição completa do vídeo",
  "headline": "chamada curta e IMPACTANTE para sobrepor no vídeo (máx 10 palavras)",
  "cta_keyword": "uma única palavra ou expressão bem curta relacionada ao produto, simples de digitar em um comentário",
  "narracao": "texto de narração — siga as instruções de estilo abaixo"
}

REGRA OBRIGATÓRIA DE DURAÇÃO (vale para qualquer estilo escolhido):
Calibre o texto de narração para caber na duração TOTAL do vídeo, usando uma cadência de aproximadamente 3,3 palavras por segundo. O comprimento do texto deve ser sempre PROPORCIONAL à duração do vídeo — nunca um número fixo de palavras. Vídeos mais longos precisam de narração mais longa; vídeos curtos precisam de narração mais curta. Termine SEMPRE com: Comenta CTA_KEYWORD que eu te envio o link! (usando o valor de cta_keyword SEM aspas ao redor da palavra, texto corrido, sempre com exclamação no final).

INSTRUÇÕES DE ESTILO (tom e estrutura do texto — não determina o tamanho, que já é definido pela regra acima):
${instrucoesEstilo}

REGRAS PARA A HEADLINE — siga rigorosamente este estilo (curiosidade, benefício direto, um pouco de humor/exagero). Varie a estrutura da frase a cada vídeo, não repita sempre o mesmo formato:
- "Essa sapateira é a cara da riqueza com preço de Shopee"
- "Barbeador que deixa pele de neném"
- "O spray que recupera farol amarelado"
- "Adeus sofrimento para tirar cravos"
NÃO use headlines genéricas do tipo "Limpe tudo sem esforço com essa escova" — prefira sempre o ângulo de curiosidade/benefício acima.
`.trim();

  const response = await ai.models.generateContent({
    model: MODELO_GEMINI,
    contents: [{ role: "user", parts: [{ fileData: { fileUri: file.uri, mimeType: file.mimeType } }, { text: prompt }] }],
  });

  await ai.files.delete({ name: uploaded.name });

  const limpo = response.text.replace(/```json|```/g, "").trim();
  return JSON.parse(limpo);
}

// ---------- Encurta a narração se ela ultrapassar o vídeo ----------

async function encurtarNarracao(textoAtual, segundosExcedentes, ctaKeyword) {
  const palavrasParaRemover = Math.ceil(segundosExcedentes * 3.3);
  const prompt = `
O texto de narração abaixo ficou aproximadamente ${segundosExcedentes.toFixed(1)} segundos mais longo do que o vídeo permite (~${palavrasParaRemover} palavras a mais que o necessário).

Reescreva mantendo o mesmo sentido, tom e estrutura, mas mais curto — remova palavras/frases redundantes, sem perder informação essencial do produto. Mantenha EXATAMENTE o mesmo final: "Comenta ${ctaKeyword} que eu te envio o link!" (sem aspas ao redor da palavra).

Retorne APENAS o novo texto de narração, sem JSON, sem aspas envolvendo o texto todo, sem comentários.

Texto atual:
${textoAtual}
`.trim();

  const response = await ai.models.generateContent({
    model: MODELO_GEMINI,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  return response.text.trim();
}

// ---------- Etapa 2: Fish Audio gera a narração ----------

async function gerarAudioNarracao(texto, voiceId, outPath, dicionario) {
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

function removerSilencios(inputPath, outputPath) {
  const cmd = `ffmpeg -y -i "${inputPath}" -af "silenceremove=stop_periods=-1:stop_duration=0.4:stop_threshold=-45dB" -c:a mp3 "${outputPath}"`;
  execSync(cmd, { stdio: "inherit" });
}

// ---------- Gera áudio, mede, e regenera mais curto se necessário ----------

async function gerarNarracaoComAjuste(narracaoInicial, ctaKeyword, videoDuracao, voiceId, tmpDir, dicionario) {
  let textoAtual = narracaoInicial;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_NARRACAO; tentativa++) {
    const brutoPath = path.join(tmpDir, `narracao_bruta_${tentativa}.mp3`);
    const limpoPath = path.join(tmpDir, `narracao_${tentativa}.mp3`);

    await gerarAudioNarracao(textoAtual, voiceId, brutoPath, dicionario);
    removerSilencios(brutoPath, limpoPath);

    const duracaoReal = duracaoAudio(limpoPath);
    const excedente = duracaoReal - videoDuracao;

    console.log(
      `  Tentativa ${tentativa}: áudio ${duracaoReal.toFixed(1)}s vs vídeo ${videoDuracao.toFixed(1)}s (excedente: ${excedente.toFixed(1)}s)`
    );

    if (excedente <= TOLERANCIA_SEGUNDOS) {
      return { audioPath: limpoPath, textoFinal: textoAtual };
    }

    if (tentativa < MAX_TENTATIVAS_NARRACAO) {
      console.log(`  Narração longa demais, pedindo ao Gemini pra encurtar...`);
      textoAtual = await encurtarNarracao(textoAtual, excedente, ctaKeyword);
    } else {
      console.log(`  Limite de tentativas atingido, usando o último áudio gerado mesmo assim.`);
      return { audioPath: limpoPath, textoFinal: textoAtual };
    }
  }
}

// ---------- Etapa 3: FFmpeg monta o vídeo final ----------

function montarVideoFinal({ videoPath, watermarkPath, avatarPath, audioPath, headline, outPath }) {
  const larguraVideoPx = larguraVideo(videoPath);

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

  const filtros = [`[1:v]scale=240:-1[wm]`, `[0:v][wm]overlay=(W-w)/2:H-h-30[vwm1]`];

  let ultimaCamada = "[vwm1]";
  const inputsExtras = [];
  let indiceProximoInput = 2;
  let indiceAudio;

if (avatarPath) {
    inputsExtras.push(`-stream_loop -1 -i "${avatarPath}"`);
    filtros.push(`[${indiceProximoInput}:v]chromakey=${COR_CHROMA}:0.15:0.05,despill=type=green,scale=350:-1[avt]`);
    filtros.push(`${ultimaCamada}[avt]overlay=20:H-h+9:shortest=1[vwm2]`);
    ultimaCamada = "[vwm2]";
    indiceAudio = indiceProximoInput + 1;
  } else {
    indiceAudio = indiceProximoInput;
  }

  filtros.push(`${ultimaCamada}${drawbox},${drawtexts}[vout]`);
  const filterComplex = filtros.join(";");

  const cmd = `ffmpeg -y -i "${videoPath}" -i "${watermarkPath}" ${inputsExtras.join(" ")} -i "${audioPath}" -filter_complex "${filterComplex}" -map "[vout]" -map ${indiceAudio}:a -c:v libx264 -c:a aac -shortest "${outPath}"`;
  execSync(cmd, { stdio: "inherit" });
}

// ---------- Orquestração do job ----------

async function processarJob(job) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-"));
  try {
    console.log(`Processando job ${job.id}...`);

    const { data: preset } = await supabase.from("brand_presets").select("*").eq("id", job.preset_id).single();
    const dicionarioPronuncia = await buscarDicionarioPronuncia();
    const instrucoesEstilo = await buscarInstrucoesEstilo(job.estilo_narracao_id);

    const videoPath = path.join(tmpDir, "original.mp4");
    const { data: videoBlob } = await supabase.storage.from("videos-originais").download(job.video_original_path);
    fs.writeFileSync(videoPath, Buffer.from(await videoBlob.arrayBuffer()));

    const watermarkPath = path.join(tmpDir, "watermark.png");
    const { data: wmBlob } = await supabase.storage.from("marcas-dagua").download(preset.watermark_path);
    fs.writeFileSync(watermarkPath, Buffer.from(await wmBlob.arrayBuffer()));

    let avatarPath = null;
    if (job.incluir_avatar && preset.avatar_path) {
      avatarPath = path.join(tmpDir, "avatar.mp4");
      const { data: avBlob } = await supabase.storage.from("avatares").download(preset.avatar_path);
      fs.writeFileSync(avatarPath, Buffer.from(await avBlob.arrayBuffer()));
    }

    const geminiJson = await analisarVideo(videoPath, instrucoesEstilo);
    await supabase.from("video_jobs").update({ status: "narrating", gemini_json: geminiJson }).eq("id", job.id);
    await supabase.from("job_events").insert({ job_id: job.id, etapa: "gemini_ok", payload: geminiJson });

    const videoDuracao = duracaoVideoTotal(videoPath);
    const { audioPath, textoFinal } = await gerarNarracaoComAjuste(
      geminiJson.narracao,
      geminiJson.cta_keyword,
      videoDuracao,
      preset.voice_id,
      tmpDir,
      dicionarioPronuncia
    );

    const geminiJsonFinal = { ...geminiJson, narracao: textoFinal };
    await supabase.from("video_jobs").update({ status: "rendering", gemini_json: geminiJsonFinal }).eq("id", job.id);

    const outPath = path.join(tmpDir, "final.mp4");
    montarVideoFinal({
      videoPath,
      watermarkPath,
      avatarPath,
      audioPath,
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
