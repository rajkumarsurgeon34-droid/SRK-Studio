# SRK Studio

Make pictures and short videos from a prompt, on your Android phone. Part of the SRK family by
Dr. M. Rajkumar · ShazVerse Technologies.

- **Free daily pictures (Cloudflare):** add your Cloudflare account ID and a token made with the *Workers AI*
  template in ⚙️ Settings. FLUX.2 Klein (any shape) and FLUX.1 Schnell (square) run on Cloudflare's free daily
  allowance, which resets at 5:30 AM India time.
- **A few pictures with no setup:** Pollinations' no-key pictures, limited to a few an hour.
- **Premium pictures and video:** add your own Pollinations key in ⚙️ Settings (get one at
  [enter.pollinations.ai](https://enter.pollinations.ai)). New accounts get a small free daily allowance;
  after that you pay Pollinations for what you make. Video models include Veo, Seedance and Wan.
- **Make it a video:** turn any free picture into the first frame of a video.
- **Your work stays on the phone:** every result is kept in the app's gallery. Save it to
  Documents › SRK Studio, or share it to Photos, WhatsApp or anywhere else.

## Install

Open the latest **Releases** page of this repo on your phone and download **SRK-Studio.apk**.
Each new build installs over the previous one.

## How it's built

A plain HTML/CSS/JavaScript app in `www/`, wrapped as an Android app with Capacitor. GitHub Actions
builds and publishes the APK on every push to `main`. Cloudflare Workers AI is called through Android's native
HTTP layer (its API doesn't accept requests from web pages). Other pictures and videos are made by
[Pollinations](https://pollinations.ai): free pictures through `image.pollinations.ai`, and everything that
needs a key through `gen.pollinations.ai`. Your key is stored only on your phone and sent only to Pollinations.
