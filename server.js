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

/* =========================
   UPLOAD
========================= */

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";

    cb(
      null,
      `${crypto.randomBytes(12).toString("hex")}${ext}`
    );
  }
});

const upload = multer({
  storage,

  limits: {
    files: 1,
    fileSize: 12 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|jpg)$/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Only JPG, PNG and WebP images are allowed."
        )
      );
    }
  }
});

/* =========================
   SETTINGS
========================= */

let prices = {
  monthly: 1000,
  yearly: 15000,
  currency: "NGN"
};

const viewOnce = new Map();
const jobs = new Map();

/* =========================
   HELPERS
========================= */

function safeText(value) {
  return String(value || "")
    .replace(/[\r\n]/g, " ")
    .slice(0, 1000);
}

function getBaseUrl(req) {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, "");
  }

  const proto =
    req.headers["x-forwarded-proto"] ||
    req.protocol ||
    "https";

  return `${String(proto).split(",")[0]}://${req.get("host")}`;
}

/* =========================
   ADMIN
========================= */

function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"];

  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

/* =========================
   PREMIUM
========================= */

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

  const parts = String(token).split(".");

  if (parts.length !== 2) return false;

  const [encoded, sig] = parts;

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

  const created = Number(
    payload.slice("premium.".length)
  );

  return (
    Number.isFinite(created) &&
    Date.now() - created <
      30 * 24 * 60 * 60 * 1000
  );
}

/* =========================
   REPLICATE
========================= */

async function startReplicate(imageUrl, prompt) {
  if (!REPLICATE_API_TOKEN) {
    throw new Error(
      "REPLICATE_API_TOKEN is missing in Render."
    );
  }

  const response = await fetch(
    "https://api.replicate.com/v1/models/wan-video/wan-2.5-i2v/predictions",
    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${REPLICATE_API_TOKEN}`,

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
      "Replicate failed to start."
    );
  }

  return data;
}

/* =========================
   DOWNLOAD VIDEO
========================= */

async function downloadVideo(url, filename) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      "Could not download generated video."
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  const destination =
    path.join(VIDEO_DIR, filename);

  fs.writeFileSync(destination, buffer);

  return `/videos/${filename}`;
}

/* =========================
   HOME
========================= */

app.get("/", (req, res) => {
  res.sendFile(
    path.join(ROOT, "index.html")
  );
});

/* =========================
   HEALTH
========================= */

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

/* =========================
   PRICES
========================= */

app.get("/api/prices", (req, res) => {
  res.json(prices);
});

app.put(
  "/api/admin/prices",
  adminAuth,
  (req, res) => {
    const monthly = Number(req.body.monthly);
    const yearly = Number(req.body.yearly);

    if (
      !Number.isFinite(monthly) ||
      !Number.isFinite(yearly) ||
      monthly < 0 ||
      yearly < 0
    ) {
      return res.status(400).json({
        error:
          "Prices must be non-negative numbers."
      });
    }

    prices.monthly = Math.round(monthly);
    prices.yearly = Math.round(yearly);

    res.json({
      ok: true,
      prices
    });
  }
);

/* =========================
   PREMIUM
========================= */

app.post(
  "/api/premium/activate",
  (req, res) => {
    const key = String(
      req.body.key || ""
    );

    if (
      !key ||
      key !== PREMIUM_ACCESS_KEY
    ) {
      return res.status(401).json({
        error:
          "Invalid Premium access key."
      });
    }

    res.json({
      ok: true,
      token: signPremiumToken(),
      message:
        "Premium activated."
    });
  }
);

app.get(
  "/api/premium/check",
  (req, res) => {
    const token =
      req.headers["x-premium-token"];

    if (!validPremiumToken(token)) {
      return res.status(403).json({
        error:
          "Premium access required."
      });
    }

    res.json({
      ok: true,
      premium: true
    });
  }
);

/* =========================
   START AI VIDEO
========================= */

app.post(
  "/api/create-video",
  upload.single("images"),
  async (req, res) => {
    let uploadedFile = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          error:
            "Please upload one image."
        });
      }

      uploadedFile = req.file;

      const prompt = safeText(
        req.body.motion ||
        req.body.outfitCommand ||
        req.body.text
      ) ||
        "Animate the person naturally with subtle realistic movement. Keep the face, body, clothing and background consistent. Add smooth cinematic camera movement.";

      const baseUrl = getBaseUrl(req);

      const imageUrl =
        `${baseUrl}/uploads/${encodeURIComponent(
          path.basename(
            uploadedFile.filename
          )
        )}`;

      console.log(
        "Starting 6-second AI video..."
      );

      const prediction =
        await startReplicate(
          imageUrl,
          prompt
        );

      const jobId = crypto
        .randomBytes(12)
        .toString("hex");

      jobs.set(jobId, {
        predictionId:
          prediction.id,

        status:
          prediction.status || "starting",

        videoUrl: null,

        createdAt: Date.now()
      });

      res.json({
        ok: true,

        jobId,

        predictionId:
          prediction.id,

        status:
          prediction.status || "starting",

        message:
          "AI video generation started."
      });

    } catch (error) {
      console.error(
        "CREATE VIDEO ERROR:",
        error
      );

      res.status(500).json({
        error:
          error.message ||
          "Could not start AI video generation."
      });

    } finally {
      if (uploadedFile?.path) {
        try {
          fs.unlinkSync(
            uploadedFile.path
          );
        } catch {}
      }
    }
  }
);

/* =========================
   CHECK AI VIDEO STATUS
========================= */

app.get(
  "/api/video-status/:jobId",
  async (req, res) => {
    try {
      const job =
        jobs.get(req.params.jobId);

      if (!job) {
        return res.status(404).json({
          error:
            "Video job not found."
        });
      }

      if (job.status === "succeeded") {
        return res.json({
          ok: true,
          status: "succeeded",
          videoUrl:
            job.videoUrl
        });
      }

      const response = await fetch(
        `https://api.replicate.com/v1/predictions/${job.predictionId}`,
        {
          headers: {
            Authorization:
              `Bearer ${REPLICATE_API_TOKEN}`
          }
        }
      );

      const prediction =
        await response.json();

      if (!response.ok) {
        throw new Error(
          prediction?.detail ||
          "Could not check video status."
        );
      }

      job.status =
        prediction.status;

      if (
        prediction.status ===
        "succeeded"
      ) {
        let output =
          prediction.output;

        if (Array.isArray(output)) {
          output = output[0];
        }

        if (!output) {
          throw new Error(
            "Replicate returned no video."
          );
        }

        const filename =
          `${req.params.jobId}.mp4`;

        job.videoUrl =
          await downloadVideo(
            output,
            filename
          );

        job.status =
          "succeeded";

        return res.json({
          ok: true,
          status: "succeeded",
          videoUrl:
            job.videoUrl
        });
      }

      if (
        prediction.status ===
          "failed" ||
        prediction.status ===
          "canceled"
      ) {
        job.status =
          prediction.status;

        return res.json({
          ok: false,
          status:
            prediction.status,
          error:
            prediction.error ||
            "AI video generation failed."
        });
      }

      res.json({
        ok: true,
        status:
          prediction.status ||
          "processing"
      });

    } catch (error) {
      console.error(
        "STATUS ERROR:",
        error
      );

      res.status(500).json({
        error:
          error.message ||
          "Could not check video."
      });
    }
  }
);

/* =========================
   VIEW ONCE
========================= */

app.get(
  "/view/:token",
  (req, res) => {
    const item =
      viewOnce.get(
        req.params.token
      );

    if (
      !item ||
      item.used ||
      item.expiresAt <
        Date.now()
    ) {
      return res.status(410).send(`
        <!doctype html>
        <html>
        <body style="font-family:Arial;text-align:center;padding:60px;background:#050507;color:white">
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
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>DE Venom AI Video</title>

        <style>
          body {
            margin:0;
            background:#050507;
            color:white;
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
          }

          p {
            text-align:center;
            opacity:.7;
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
            DE Venom · 6-second AI video
          </p>
        </main>
      </body>
      </html>
    `);
  }
);

/* =========================
   OUTFIT COMMAND
========================= */

app.post(
  "/api/outfit-edit",
  (req, res) => {
    const command =
      safeText(req.body.command);

    if (!command) {
      return res.status(400).json({
        error:
          "Enter a movement command."
      });
    }

    res.json({
      ok: true,
      command,

      message:
        "Movement command received. Use the main creator to generate the AI video."
    });
  }
);

/* =========================
   ERRORS
========================= */

app.use(
  (err, req, res, next) => {
    console.error(err);

    res.status(400).json({
      error:
        err.message ||
        "Request failed."
    });
  }
);

/* =========================
   START
========================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `DE Venom running on port ${PORT}`
    );

    console.log(
      `AI video enabled: ${Boolean(
        REPLICATE_API_TOKEN
      )}`
    );
  }
);
