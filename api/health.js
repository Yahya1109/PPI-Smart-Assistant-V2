export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const model = process.env.OPENAI_MODEL || "gpt-6.1-terra";
  return res.status(200).json({
    ok: true,
    service: "PPI Smart Assistant API",
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    model
  });
}
