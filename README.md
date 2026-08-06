# DE Venom

A fresh Node.js + Express website ready for GitHub and Render.

## Included

- Cinematic homepage
- Image + text → 20-second MP4
- Up to 8 images per creation
- View-once video links
- ₦1,000 monthly Premium display
- ₦15,000 yearly Premium display
- Admin price-control API
- Outfit-edit command interface
- `/health` Render health endpoint
- No Paystack/payment integration yet

## Run locally

```bash
npm install
ADMIN_KEY=my-secret npm start
```

Then open:

`http://localhost:10000`

Health check:

`http://localhost:10000/health`

## Deploy on Render

1. Create a new GitHub repository.
2. Upload `server.js`, `package.json`, `render.yaml`, `README.md`, and the `public` folder.
3. Create a Render Web Service from the GitHub repository.
4. Build command: `npm install`
5. Start command: `npm start`
6. Add environment variables:
   - `ADMIN_KEY` = a secret key you choose
   - `BASE_URL` = your Render URL, for example `https://your-app.onrender.com`
7. Deploy.

## Important

This version generates the cinematic video itself using FFmpeg. The clothing-edit command interface is ready for connection to an image-editing AI provider. It is intended for legitimate outfit/clothing transformations.

View-once tokens are stored in memory, so they reset when the Render service restarts/redeploys. For a production version, replace the in-memory Map with Redis or a database.

No Paystack is required. The Premium prices are display-only until you decide to add payment processing.


## DE Venom visual/editor update

The homepage uses a dark navy-blue cinematic visual style.

The clothing editor accepts natural-language clothing transformations. For example:
- Change the outfit to a black suit.
- Change the dress to navy blue.
- Add a white shirt and jacket.
- Change the character's outfit to traditional clothing.

The project intentionally does not include an undressing/clothing-removal feature.


## Premium access behavior

- **Free users:** can use the creator, but generated videos are delivered as **view-once links**.
- **Premium users:** can activate Premium and receive a normal persistent video link instead of being restricted to view-once playback.
- Set `PREMIUM_ACCESS_KEY` in Render to the key you want to use for Premium activation.
- Set `SESSION_SECRET` in Render to a long random secret.
- This version does not process payments yet. The Premium key is a temporary access mechanism until Paystack or another payment provider is connected.
- For real subscriptions, replace the key mechanism with a database-backed user/subscription system and payment webhooks.
