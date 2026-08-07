const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;

const ADMIN_KEY = process.env.ADMIN_KEY || "change-me-admin-key";
const PREMIUM_ACCESS_KEY =
  process.env.PREMIUM_ACCESS_KEY || "change-me-premium-key";
const SESSION_SECRET =
  process.env.SESSION_SECRET || "change-me-session-secret";

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

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

/* -----------------------------
   FILE UPLOAD
----------------------------- */

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${crypto.randomBytes(12).toString("hex")}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    files: 8,
    fileSize: 12 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|jpg)$/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPG, PNG and WebP images are allowed."));
    }
  }
});

/* -----------------------------
   SETTINGS
----------------------------- */

let prices = {
  monthly: 1000,
  yearly: 15000,
  currency: "NGN"
};

const viewOnce = new Map();

/* -----------------------------
   HELPERS
----------------------------- */

function safeText(value) {
  return String(value || "")
    .replace(/[\r\n]/g, " ")
    .slice(0, 1000);
}

function getPublicBaseUrl(req) {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, "");
  }

  const forwardedProto =
    req.headers["x-forwarded-proto"] || req.protocol || "https";

  const protocol = String(forwardedProto).split(",")[0];

  return `${protocol}://${req.get("host")}`;
}

function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"];

  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

/* -----------------------------
   PREMIUM
----------------------------- */

function signPremiumToken() {
  const payload = `premium.${Date.now()}`;

  const sig = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("hex");

  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

function validPremiumToken(token) {
  if (!token) return false;

  const [encoded, sig] = String(token).split(".");

  if (!encoded || !sig) return false;

  let payload;

  try {
    payload = Buffer.from(encoded, "base64url").toString();
  } catch {
    return false;
  }

  if (!payload.startsWith("premium.")) return false;

  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("hex");

  if (sig.length !== expected.length) return false;

  if (
    !crypto.timingSafeEqual(
      Buffer.from(sig),
      Buffer.from(expected)
    )
  ) {
    return false;
  }

  const created = Number(payload.slice("premium.".length));

  return (
    Number.isFinite(created) &&
    Date.now() - created < 30 * 24 * 60 * 60 * 1000
  );
}

/* -----------------------------
   REPLICATE
----------------------------- */

async function createReplicatePrediction(imageUrl, prompt) {
  if (!REPLICATE_API_TOKEN) {
    throw new Error(
      "REPLICATE_API_TOKEN is missing. Add it to Render Environment Variables."
    );
  }

  const response = await fetch(
    "https://api.replicate.com/v1/models/wan-video/wan-2.5-i2v/predictions",
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        input: {
          image: imageUrl,

          prompt,

          duration: 6,

          resolution: "720p",

          negative_prompt:
            "blurry, distorted face, deformed body, extra limbs, duplicate person, unnatural movement, flickering, warped hands",

          enable_prompt_expansion: true
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.detail ||
        data?.error ||
        "Replicate could not start the video generation."
    );
  }

  return data;
}

async function waitForPrediction(predictionId) {
  const maxAttempts = 90;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(
      `https://api.replicate.com/v1/predictions/${predictionId}`,
      {
        headers: {
          Authorization: `Bearer ${REPLICATE_API_TOKEN}`
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data?.detail ||
          data?.error ||
          "Could not check video generation status."
      );
    }

    if (data.status === "succeeded") {
      return data;
    }

    if (
      data.status === "failed" ||
      data.status === "canceled"
    ) {
      throw new Error(
        data.error || "AI video generation failed."
      );
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error(
    "Video generation took too long. Please try again."
  );
}

async function downloadVideo(url, destination) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("The generated video could not be downloaded.");
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  fs.writeFileSync(destination, buffer);
}

/* -----------------------------
   CREATE AI VIDEO
----------------------------- */

async function createVideo(req, file, movementCommand) {
  const baseUrl = getPublicBaseUrl(req);

  const imageUrl =
    `${baseUrl}/uploads/${encodeURIComponent(
      path.basename(file.filename)
    )}`;

  const prompt =
    safeText(movementCommand) ||
    "Animate the person naturally with subtle realistic movement. " +
      "Keep the person's identity, face, clothing, body, and background consistent. " +
      "Use smooth cinematic camera movement.";

  console.log("Starting AI video generation...");
  console.log("Image:", imageUrl);
  console.log("Prompt:", prompt);

  const prediction = await createReplicatePrediction(
    imageUrl,
    prompt
  );

  console.log("Replicate prediction:", prediction.id);

  const completed = await waitForPrediction(prediction.id);

  let outputUrl = completed.output;

  if (Array.isArray(outputUrl)) {
    outputUrl = outputUrl[0];
  }

  if (!outputUrl) {
    throw new Error("Replicate returned no video.");
  }

  const jobId = crypto.randomBytes(8).toString("hex");
  const filename = `${jobId}.mp4`;
  const outputPath = path.join(VIDEO_DIR, filename);

  await downloadVideo(outputUrl, outputPath);

  return {
    jobId,
    videoUrl: `/videos/${filename}`
  };
}

/* -----------------------------
   HOME
----------------------------- */

app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

/* -----------------------------
   HEALTH
----------------------------- */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "DE Venom",
    aiVideo: Boolean(REPLICATE_API_TOKEN),
    model: "wan-video/wan-2.5-i2v",
    duration: 6,
    timestamp: new Date().toISOString()
  });
});

/* -----------------------------
   PRICES
----------------------------- */

app.get("/api/prices", (req, res) => {
  res.json(prices);
});

app.put("/api/admin/prices", adminAuth, (req, res) => {
  const monthly = Number(req.body.monthly);
  const yearly = Number(req.body.yearly);

  if (
    !Number.isFinite(monthly) ||
    !Number.isFinite(yearly) ||
    monthly < 0 ||
    yearly < 0
  ) {
    return res.status(400).json({
      error: "Prices must be non-negative numbers."
    });
  }

  prices.monthly = Math.round(monthly);
  prices.yearly = Math.round(yearly);

  res.json({
    ok: true,
    prices
  });
});

/* -----------------------------
   PREMIUM ACTIVATION
----------------------------- */

app.post("/api/premium/activate", (req, res) => {
  const key = String(req.body.key || "");

  if (!key || key !== PREMIUM_ACCESS_KEY) {
    return res.status(401).json({
      error: "Invalid Premium access key."
    });
  }

  res.json({
    ok: true,
    token: signPremiumToken(),
    message: "Premium activated for this browser session."
  });
});

app.get("/api/premium/check", (req, res) => {
  const token = req.headers["x-premium-token"];

  if (!validPremiumToken(token)) {
    return res.status(403).json({
      error: "Premium access required."
    });
  }

  res.json({
    ok: true,
    premium: true
  });
});

/* -----------------------------
   AI IMAGE → VIDEO
----------------------------- */

app.post(
  "/api/create-video",
  upload.single("images"),
  async (req, res) => {
    let uploadedFile = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          error: "Please upload one image."
        });
      }

      uploadedFile = req.file;

      const movementCommand = safeText(
        req.body.outfitCommand ||
          req.body.motion ||
          req.body.text
      );

      const result = await createVideo(
        req,
        uploadedFile,
        movementCommand
      );

      const isPremium = validPremiumToken(
        req.headers["x-premium-token"]
      );

      const token = crypto.randomBytes(18).toString("hex");

      viewOnce.set(token, {
        video: result.videoUrl,
        used: false,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000
      });

      res.json({
        ok: true,
        premium: isPremium,

        message:
          "Your 6-second AI moving video has been created.",

        jobId: result.jobId,

        videoUrl: result.videoUrl,

        viewOnceUrl: `/view/${token}`,

        persistentUrl: isPremium
          ? result.videoUrl
          : null
      });
    } catch (err) {
      console.error("VIDEO ERROR:", err);

      res.status(500).json({
        error:
          err.message ||
          "AI video generation failed."
      });
    } finally {
      if (uploadedFile?.path) {
        try {
          fs.unlinkSync(uploadedFile.path);
        } catch {}
      }
    }
  }
);

/* -----------------------------
   VIEW ONCE
----------------------------- */

app.get("/view/:token", (req, res) => {
  const item = viewOnce.get(req.params.token);

  if (
    !item ||
    item.used ||
    item.expiresAt < Date.now()
  ) {
    return res.status(410).send(`
      <!doctype html>
      <html>
      <body style="font-family:Arial;text-align:center;padding:60px">
        <h1>View-once link unavailable</h1>
        <p>This link has already been viewed or has expired.</p>
      </body>
      </html>
    `);
  }

  item.used = true;

  res.send(`
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport"
        content="width=device-width,initial-scale=1">
      <title>DE Venom AI Video</title>

      <style>
        body {
          margin:0;
          background:#050507;
          color:#fff;
          font-family:Arial,sans-serif;
          display:grid;
          place-items:center;
          min-height:100vh;
        }

        main {
          width:min(1000px,94vw);
        }

        video {
          width:100%;
          border-radius:18px;
          box-shadow:0 20px 80px #000;
        }

        p {
          opacity:.7;
          text-align:center;
        }
      </style>
    </head>

    <body>
      <main>
        <video
          controls
          autoplay
          playsinline
          src="${item.video}">
        </video>

        <p>
          DE Venom · 6-second AI image-to-video
        </p>
      </main>
    </body>
    </html>
  `);
});

/* -----------------------------
   CLOTHING COMMAND
----------------------------- */

app.post("/api/outfit-edit", (req, res) => {
  const command = safeText(req.body.command);

  if (!command) {
    return res.status(400).json({
      error: "Enter an outfit command."
    });
  }

  res.json({
    ok: true,
    mode: "video-motion-command",
    command,
    message:
      "For actual clothing changes, an image-editing model must be connected separately. The image-to-video generator will animate the existing clothing."
  });
});

/* -----------------------------
   ERRORS
----------------------------- */

app.use((err, req, res, next) => {
  console.error(err);

  res.status(400).json({
    error:
      err.message ||
      "Request failed."
  });
});

/* -----------------------------
   START SERVER
----------------------------- */

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `DE Venom running on port ${PORT}`
  );

  console.log(
    `AI video enabled: ${Boolean(
      REPLICATE_API_TOKEN
    )}`
  );
});
