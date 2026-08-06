const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me-admin-key";
const PREMIUM_ACCESS_KEY = process.env.PREMIUM_ACCESS_KEY || "change-me-premium-key";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me-session-secret";

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const VIDEO_DIR = path.join(ROOT, "videos");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(ROOT));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use("/videos", express.static(VIDEO_DIR));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { files: 8, fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|jpg)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPG, PNG and WebP images are allowed."));
  }
});

let prices = {
  monthly: 1000,
  yearly: 15000,
  currency: "NGN"
};

// Demo-friendly in-memory view-once tokens.
// For production, replace this Map with Redis/Postgres so tokens survive restarts.
const viewOnce = new Map();

function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function signPremiumToken() {
  const payload = `premium.${Date.now()}`;
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

function validPremiumToken(token) {
  if (!token) return false;
  const [encoded, sig] = token.split(".");
  if (!encoded || !sig) return false;
  const payload = Buffer.from(encoded, "base64url").toString();
  if (!payload.startsWith("premium.")) return false;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const created = Number(payload.slice("premium.".length));
  return Number.isFinite(created) && Date.now() - created < 30 * 24 * 60 * 60 * 1000;
}

function premiumAuth(req, res, next) {
  const token = req.headers["x-premium-token"];
  if (!validPremiumToken(token)) {
    return res.status(403).json({
      error: "Premium access required.",
      message: "Free users can create view-once videos. Premium users can create videos with normal persistent links."
    });
  }
  next();
}

app.post("/api/premium/activate", (req, res) => {
  const key = String(req.body.key || "");
  if (!key || key !== PREMIUM_ACCESS_KEY) {
    return res.status(401).json({ error: "Invalid Premium access key." });
  }
  res.json({
    ok: true,
    token: signPremiumToken(),
    message: "Premium activated for this browser session."
  });
});

function safeText(value) {
  return String(value || "")
    .replace(/[\r\n]/g, " ")
    .slice(0, 180);
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args);
    let stderr = "";
    child.stderr.on("data", d => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-5000) || `FFmpeg exited with ${code}`));
    });
  });
}

async function createVideo(files, caption, outfitCommand) {
  const jobId = crypto.randomBytes(8).toString("hex");
  const jobDir = path.join(VIDEO_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const normalized = [];
  try {
    // Normalize all source images to the same 1920x1080 canvas.
    for (let i = 0; i < files.length; i++) {
      const out = path.join(jobDir, `img-${i}.jpg`);
      await runFFmpeg([
        "-y",
        "-i", files[i].path,
        "-vf",
        "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1",
        "-q:v", "3",
        out
      ]);
      normalized.push(out);
    }

    const listFile = path.join(jobDir, "concat.txt");
    let list = "";
    const duration = 20 / normalized.length;
    for (const file of normalized) {
      list += `file '${file.replace(/'/g, "'\\''")}'\n`;
      list += `duration ${duration}\n`;
    }
    // Repeat last frame so concat duration is honored reliably.
    list += `file '${normalized[normalized.length - 1].replace(/'/g, "'\\''")}'\n`;
    fs.writeFileSync(listFile, list);

    const output = path.join(VIDEO_DIR, `${jobId}.mp4`);
    const escapedCaption = safeText(caption)
      .replace(/\\/g, "\\\\")
      .replace(/:/g, "\\:")
      .replace(/'/g, "\\'")
      .replace(/%/g, "\\%");

    // Outfit command is intentionally displayed as creative direction.
    // Actual generative outfit replacement would require an image-editing AI provider.
    const finalCaption = escapedCaption || "Cinematic moment";
    const vf =
      `scale=1920:1080:force_original_aspect_ratio=disable,` +
      `format=yuv420p,` +
      `drawbox=x=0:y=830:w=1920:h=250:color=black@0.42:t=fill,` +
      `drawtext=text='${finalCaption}':fontcolor=white:fontsize=54:` +
      `x=80:y=900:shadowcolor=black@0.7:shadowx=2:shadowy=2`;

    await runFFmpeg([
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listFile,
      "-vf", vf,
      "-t", "20",
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      output
    ]);

    const token = crypto.randomBytes(18).toString("hex");
    viewOnce.set(token, {
      video: `/videos/${jobId}.mp4`,
      used: false,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      outfitCommand: safeText(outfitCommand)
    });

    return {
      token,
      url: `${BASE_URL}/view/${token}` || `/view/${token}`,
      videoUrl: `/videos/${jobId}.mp4`,
      jobId
    };
  } finally {
    for (const file of files) {
      try { fs.unlinkSync(file.path); } catch {}
    }
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
  }
}


app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "DE Venom",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/prices", (req, res) => {
  res.json(prices);
});

app.put("/api/admin/prices", adminAuth, (req, res) => {
  const monthly = Number(req.body.monthly);
  const yearly = Number(req.body.yearly);

  if (!Number.isFinite(monthly) || !Number.isFinite(yearly) || monthly < 0 || yearly < 0) {
    return res.status(400).json({ error: "Prices must be non-negative numbers." });
  }

  prices.monthly = Math.round(monthly);
  prices.yearly = Math.round(yearly);
  res.json({ ok: true, prices });
});

app.post("/api/create-video", upload.array("images", 8), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Upload at least one image." });
    }

    const caption = safeText(req.body.text);
    const outfitCommand = safeText(req.body.outfitCommand);

    const result = await createVideo(req.files, caption, outfitCommand);
    const isPremium = validPremiumToken(req.headers["x-premium-token"]);

    res.json({
      ok: true,
      premium: isPremium,
      message: isPremium
        ? "20-second cinematic video created with Premium access."
        : "20-second cinematic video created as a view-once link.",
      ...result,
      viewOnceUrl: `/view/${result.token}`,
      persistentUrl: isPremium ? result.videoUrl : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Video creation failed.",
      details: err.message
    });
  }
});

app.get("/api/premium/check", premiumAuth, (req, res) => {
  res.json({ ok: true, premium: true });
});

app.get("/view/:token", (req, res) => {
  const item = viewOnce.get(req.params.token);
  if (!item || item.used || item.expiresAt < Date.now()) {
    return res.status(410).send(`
      <!doctype html><html><body style="font-family:Arial;text-align:center;padding:60px">
      <h1>View-once link unavailable</h1><p>This link has already been viewed or has expired.</p>
      </body></html>
    `);
  }

  item.used = true;
  res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>View Once · Cinematic Studio</title>
<style>
body{margin:0;background:#050507;color:#fff;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh}
main{width:min(1000px,94vw)}video{width:100%;border-radius:18px;box-shadow:0 20px 80px #000}p{opacity:.7;text-align:center}
</style></head><body><main>
<video controls autoplay playsinline src="${item.video}"></video>
<p>This is a view-once cinematic link. Refreshing or reopening it will not replay the video.</p>
</main></body></html>`);
});

app.post("/api/outfit-edit", (req, res) => {
  const command = safeText(req.body.command);
  if (!command) return res.status(400).json({ error: "Enter an outfit command." });

  res.json({
    ok: true,
    mode: "clothing-edit-command",
    command,
    message: "Clothing-edit command received. Connect an image-editing AI provider to apply the requested clothing transformation to the uploaded image."
  });
});

app.use((err, req, res, next) => {
  if (err) {
    return res.status(400).json({ error: err.message || "Request failed." });
  }
  next();
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DE Venom running on port ${PORT}`);
});
