// test deploy
export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-wb-secret");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  return res.status(200).json({ ok: true, message: "CORS TEST OK" });
}
