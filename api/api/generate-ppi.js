import OpenAI from "openai";

const MODEL = process.env.OPENAI_MODEL || "gpt-6.1-terra";

const SYSTEM_PROMPT = `Anda adalah asisten profesional untuk membantu guru menyusun draf Program Pembelajaran Individual (PPI) dalam konteks pendidikan inklusif di Indonesia.

Tugas:
- Gunakan hanya informasi kemampuan fungsional dan kebutuhan belajar yang diberikan.
- Rumuskan tujuan yang spesifik, terukur, dapat dicapai, relevan, dan memiliki batas waktu.
- Bedakan tujuan jangka panjang, tujuan jangka pendek, indikator keberhasilan, strategi, media, adaptasi, dan program mingguan.
- Setiap indikator harus dapat diamati dan dicatat guru.
- Rencana mingguan harus realistis, bertahap, dan sesuai informasi asesmen.
- Jangan mengarang hasil asesmen, diagnosis, tingkat kemampuan, atau kondisi keluarga.
- Jangan mengubah deskripsi menjadi diagnosis medis. Hindari pelabelan dan bahasa yang merendahkan peserta didik.
- Jika data tidak cukup, tulis keterbatasannya pada catatan_validasi dan sarankan asesmen/observasi tambahan.
- Berikan pilihan strategi, bukan keputusan otomatis. Guru dan tim sekolah wajib meninjau hasilnya.
- Jawab dalam Bahasa Indonesia yang jelas dan profesional.

Keluarkan JSON valid saja dengan struktur:
{
  "tujuan_jangka_panjang": "string",
  "tujuan_jangka_pendek": ["string"],
  "indikator_keberhasilan": ["string"],
  "strategi": ["string"],
  "media": ["string"],
  "adaptasi": {
    "materi": "string",
    "instruksi": "string",
    "waktu": "string",
    "evaluasi": "string"
  },
  "program_mingguan": [
    {"minggu": "string", "aktivitas": "string", "evaluasi": "string"}
  ],
  "catatan_validasi": ["string"]
}`;

function cleanText(value, maxLength = 2500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function normalizeList(value, maxItems = 10) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxItems)
    .map((item) => cleanText(String(item ?? ""), 600))
    .filter(Boolean);
}

function normalizeDraft(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Format hasil AI tidak dikenali.");
  }

  const adaptasi = value.adaptasi && typeof value.adaptasi === "object"
    ? value.adaptasi
    : {};
  const program = Array.isArray(value.program_mingguan)
    ? value.program_mingguan
    : [];
  const tujuan = cleanText(value.tujuan_jangka_panjang, 1200);

  if (!tujuan) {
    throw new Error("AI belum menghasilkan tujuan jangka panjang.");
  }

  return {
    tujuan_jangka_panjang: tujuan,
    tujuan_jangka_pendek: normalizeList(value.tujuan_jangka_pendek, 8),
    indikator_keberhasilan: normalizeList(value.indikator_keberhasilan, 10),
    strategi: normalizeList(value.strategi, 10),
    media: normalizeList(value.media, 10),
    adaptasi: {
      materi: cleanText(adaptasi.materi, 600),
      instruksi: cleanText(adaptasi.instruksi, 600),
      waktu: cleanText(adaptasi.waktu, 600),
      evaluasi: cleanText(adaptasi.evaluasi, 600)
    },
    program_mingguan: program.slice(0, 12).map((row, index) => ({
      minggu: cleanText(row?.minggu, 40) || `M-${index + 1}`,
      aktivitas: cleanText(row?.aktivitas, 700),
      evaluasi: cleanText(row?.evaluasi, 500)
    })).filter((row) => row.aktivitas),
    catatan_validasi: normalizeList(value.catatan_validasi, 10)
  };
}

// Best-effort per-instance throttle. For a public multi-user deployment, add a shared
// rate-limit store and authentication; serverless instances do not share this Map.
const hits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const limit = 8;
  const previous = hits.get(ip) || [];
  const recent = previous.filter((time) => now - time < windowMs);
  if (recent.length >= limit) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 500) {
    for (const [key, times] of hits) {
      if (!times.some((time) => now - time < windowMs)) hits.delete(key);
    }
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "OPENAI_API_KEY belum diatur pada Vercel. Tambahkan Environment Variable lalu redeploy."
    });
  }

  const forwarded = req.headers["x-forwarded-for"];
  const ip = (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "") ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isRateLimited(ip)) {
    return res.status(429).json({
      error: "Terlalu banyak permintaan dari jaringan ini. Tunggu 5 menit lalu coba kembali."
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Format JSON permintaan tidak valid." }); }
  }
  body = body && typeof body === "object" ? body : {};

  const prompt = cleanText(body.prompt, 3000);
  const rawAssessment = body.assessment && typeof body.assessment === "object"
    ? body.assessment
    : {};
  const assessment = {
    akademik: cleanText(rawAssessment.akademik, 2500),
    komunikasi: cleanText(rawAssessment.komunikasi, 2500),
    sosial: cleanText(rawAssessment.sosial, 2500),
    motorik: cleanText(rawAssessment.motorik, 2500)
  };

  if (!prompt) {
    return res.status(400).json({ error: "Deskripsi kebutuhan pembelajaran wajib diisi." });
  }
  if (!Object.values(assessment).some(Boolean)) {
    return res.status(400).json({
      error: "Asesmen awal belum berisi informasi. Isi minimal satu area asesmen."
    });
  }

  try {
    const client = new OpenAI({ apiKey, timeout: 50000, maxRetries: 1 });
    const response = await client.responses.create({
      model: MODEL,
      store: false,
      max_output_tokens: 2400,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            fokus_kebutuhan_pembelajaran: prompt,
            hasil_asesmen_fungsional: assessment
          })
        }
      ],
      text: { format: { type: "json_object" } }
    });

    if (!response.output_text) {
      throw new Error("Model tidak mengembalikan teks hasil.");
    }

    const parsed = JSON.parse(response.output_text);
    const data = normalizeDraft(parsed);
    return res.status(200).json({ ok: true, model: MODEL, data });
  } catch (error) {
    console.error("PPI AI request failed:", error?.status || "", error?.message || error);

    if (error?.status === 401) {
      return res.status(502).json({ error: "API key OpenAI tidak valid. Periksa OPENAI_API_KEY di Vercel." });
    }
    if (error?.status === 429) {
      return res.status(502).json({
        error: "Kuota atau batas penggunaan API tercapai. Periksa billing dan limit pada akun OpenAI API."
      });
    }
    if (error?.status === 404) {
      return res.status(502).json({
        error: `Model "${MODEL}" tidak ditemukan atau belum tersedia untuk akun API ini. Atur OPENAI_MODEL ke model yang tersedia pada akun Anda.`
      });
    }

    return res.status(502).json({
      error: "AI gagal memproses permintaan. Periksa OPENAI_MODEL, billing API, dan Vercel Function Logs."
    });
  }
}
