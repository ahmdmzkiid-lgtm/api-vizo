import OpenAI from 'openai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure .env is loaded even when ai.js is imported before server index finishes dotenv setup
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

/**
 * AI Service — OpenAI-Compatible dengan Custom Base URL
 * Digunakan untuk generate pembahasan soal secara otomatis.
 */

function getOpenAIConfig() {
  const apiKey = process.env.AI_API_KEY || 'sk-d7c4369c7a0ff2b4-47kec0-e94afa91';
  const baseURL = process.env.AI_BASE_URL || 'https://9.ahmdmzki.web.id/v1';
  const model = process.env.AI_MODEL || 'gh/gpt-4o';
  const maxTokens = parseInt(process.env.AI_MAX_TOKENS || '1024', 10);

  const client = new OpenAI({
    apiKey,
    baseURL,
  });

  return { client, model, maxTokens };
}

// Rate limiter sederhana: max 20 request per menit per user
const rateLimitMap = new Map();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

export function checkRateLimit(userId) {
  const now = Date.now();
  const key = `user_${userId}`;
  const entry = rateLimitMap.get(key);

  if (!entry) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT) {
    return false;
  }

  entry.count++;
  return true;
}

/**
 * Build system prompt berdasarkan tipe soal
 */
export function buildSystemPrompt() {
  return `Kamu adalah tutor akademik cerdas yang membantu mahasiswa Indonesia memahami materi kuliah. Tugasmu adalah memberikan pembahasan soal yang jelas, terstruktur, dan mudah dipahami.

ATURAN PENTING:
- Gunakan Bahasa Indonesia yang baik dan natural
- JANGAN gunakan format Markdown apapun (tidak boleh pakai tanda bintang, hashtag, backtick, dsb)
- Tulis dalam paragraf biasa dengan kalimat yang mengalir
- Gunakan penomoran angka biasa (1. 2. 3.) jika perlu membuat daftar
- Gunakan huruf kapital untuk penekanan, bukan bold/italic
- Pisahkan bagian-bagian dengan baris kosong saja
- Jelaskan dengan ringkas tapi mendalam

FORMAT PEMBAHASAN:

Untuk soal Pilihan Ganda:
1. Sebutkan jawaban yang benar
2. Jelaskan MENGAPA jawaban tersebut benar (konsep utamanya)
3. Jelaskan singkat mengapa opsi lain salah
4. Jika ada referensi halaman, sebutkan

Untuk soal Isian Singkat:
1. Sebutkan jawaban yang benar
2. Jelaskan definisi atau konsep di balik jawaban
3. Berikan contoh penerapan jika relevan

Untuk soal Essay:
1. Berikan poin-poin kunci yang seharusnya ada dalam jawaban
2. Jelaskan rubrik penilaian secara ringkas
3. Berikan contoh jawaban ideal yang singkat`;
}

/**
 * Build user prompt dari data soal
 */
export function buildUserPrompt(questionData) {
  const {
    type,
    questionText,
    options,
    correctAnswer,
    userAnswer,
    isCorrect,
    pageReference,
    explanation,
    essayRubric,
    sessionInfo,
  } = questionData;

  let prompt = '';

  if (sessionInfo) {
    prompt += `Mata kuliah pertemuan ke-${sessionInfo.sessionNumber}`;
    if (sessionInfo.topicTitle) prompt += ` tentang "${sessionInfo.topicTitle}"`;
    prompt += '.\n';
  }

  if (pageReference) {
    prompt += `Referensi: Slide halaman ${pageReference}.\n`;
  }

  prompt += `\nTipe soal: ${
    type === 'MULTIPLE_CHOICE'
      ? 'Pilihan Ganda'
      : type === 'SHORT_ANSWER'
      ? 'Isian Singkat'
      : 'Essay'
  }\n`;
  prompt += `\nSoal:\n${questionText}\n`;

  if (type === 'MULTIPLE_CHOICE' && options) {
    const letters = ['A', 'B', 'C', 'D', 'E'];
    const optionList = Array.isArray(options) ? options : [];
    prompt += '\nPilihan jawaban:\n';
    optionList.forEach((opt, i) => {
      prompt += `${letters[i]}. ${opt}\n`;
    });
  }

  if (correctAnswer) {
    prompt += `\nKunci jawaban yang benar: ${correctAnswer}\n`;
  }

  if (userAnswer !== undefined && userAnswer !== null) {
    prompt += `Jawaban mahasiswa: ${userAnswer}`;
    if (isCorrect === true) prompt += ' (BENAR)';
    else if (isCorrect === false) prompt += ' (SALAH)';
    prompt += '\n';
  }

  if (explanation) {
    prompt += `\nPembahasan manual yang sudah ada: ${explanation}\n`;
    prompt += 'Perkaya pembahasan di atas dengan penjelasan yang lebih mendalam.\n';
  }

  if (essayRubric) {
    prompt += `\nRubrik penilaian essay: ${essayRubric}\n`;
  }

  prompt += '\nBerikan pembahasan yang jelas dan mudah dipahami.';

  return prompt;
}

/**
 * Fallback penjelasan terstruktur apabila layanan AI eksternal sedang gangguan
 */
export function buildFallbackExplanation(questionData) {
  const {
    type,
    questionText,
    options,
    correctAnswer,
    userAnswer,
    isCorrect,
    pageReference,
    explanation,
    essayRubric,
    sessionInfo,
  } = questionData;

  const letters = ['A', 'B', 'C', 'D', 'E'];
  const optionList = Array.isArray(options) ? options : [];
  const correctIdx = letters.indexOf(String(correctAnswer || '').toUpperCase());
  const correctOptionText =
    correctIdx >= 0 && optionList[correctIdx]
      ? `${correctAnswer}. ${optionList[correctIdx]}`
      : correctAnswer || 'Sesuai rubrik dosen';

  const parts = [];

  if (type === 'MULTIPLE_CHOICE') {
    parts.push(
      `1. JAWABAN YANG BENAR: ${correctOptionText}${
        userAnswer
          ? isCorrect
            ? ` (Jawaban kamu ${userAnswer} sudah TEPAT).`
            : ` (Jawaban kamu adalah ${userAnswer}, sedangkan kunci jawaban yang tepat adalah ${correctAnswer}).`
          : '.'
      }`
    );

    if (explanation) {
      parts.push(`2. KONSEP UTAMA: ${explanation}`);
    } else {
      parts.push(
        `2. KONSEP UTAMA: Berdasarkan pertanyaan "${questionText}", opsi ${correctOptionText} merupakan pernyataan yang paling akurat sesuai konteks materi perkuliahan${
          sessionInfo?.topicTitle ? ` pada topik "${sessionInfo.topicTitle}"` : ''
        }.`
      );
    }

    const otherOptions = optionList
      .map((opt, idx) => ({ letter: letters[idx], text: opt }))
      .filter((item) => item.letter !== correctAnswer && item.text);

    if (otherOptions.length > 0) {
      const distractorSummary = otherOptions
        .map((o) => `opsi ${o.letter} (${o.text})`)
        .join(', ');
      parts.push(
        `3. ANALISIS OPSI LAIN: Pilihan ${distractorSummary} kurang tepat karena tidak memenuhi definisi atau karakteristik utama yang ditanyakan pada soal.`
      );
    }
  } else if (type === 'SHORT_ANSWER') {
    parts.push(`1. JAWABAN YANG BENAR: ${correctAnswer || '-'}`);
    parts.push(
      `2. PENJELASAN KONSEP: ${
        explanation ||
        `Istilah atau konsep "${correctAnswer}" merupakan jawaban kunci untuk pertanyaan "${questionText}" sesuai cakupan materi pertemuan ini.`
      }`
    );
  } else {
    parts.push(
      `1. POIN KUNCI JAWABAN ESSAY: ${
        essayRubric ||
        explanation ||
        'Pastikan jawaban memuat definisi konsep utama, cara kerja/mekanisme, serta contoh penerapannya sesuai materi perkuliahan.'
      }`
    );
  }

  if (pageReference || sessionInfo) {
    parts.push(
      `REFERENSI MATERI: Silakan tinjau kembali ${
        sessionInfo ? `Pertemuan M-${String(sessionInfo.sessionNumber || 1).padStart(2, '0')}` : 'materi kuliah'
      }${sessionInfo?.topicTitle ? ` (${sessionInfo.topicTitle})` : ''}${
        pageReference ? ` pada Slide Halaman ${pageReference}` : ''
      } untuk pendalaman lebih lanjut.`
    );
  }

  return parts.join('\n\n');
}

/**
 * Generate penjelasan AI secara streaming
 * @param {object} questionData — data soal
 * @returns {AsyncIterable} stream of text chunks
 */
export async function* streamExplanation(questionData) {
  const { client, model, maxTokens } = getOpenAIConfig();
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(questionData);

  try {
    const stream = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature: 0.7,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    let yieldedAny = false;
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        yieldedAny = true;
        yield delta;
      }
    }

    if (!yieldedAny) {
      yield buildFallbackExplanation(questionData);
    }
  } catch (err) {
    console.warn('Primary AI stream failed, using structured academic fallback:', err?.message);
    yield buildFallbackExplanation(questionData);
  }
}

/**
 * Generate penjelasan AI non-streaming (untuk cache)
 */
export async function generateExplanation(questionData) {
  const { client, model, maxTokens } = getOpenAIConfig();
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(questionData);

  try {
    const response = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    return response.choices?.[0]?.message?.content || buildFallbackExplanation(questionData);
  } catch (err) {
    console.warn('Primary AI generation failed, using structured academic fallback:', err?.message);
    return buildFallbackExplanation(questionData);
  }
}
