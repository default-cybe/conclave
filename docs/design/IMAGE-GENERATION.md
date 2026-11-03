# Image generation: make and edit pictures from chat

Status: phase 1 built (feat/image-generation, 2026-11-03): GenerateImage on the chat and assistant agents, cliproxy/gpt-image-2.5 by default, medium quality unless the owner asks for the best, no daily cap, members on their own keys only. Web and Android show a grid with a full-screen viewer as soon as the call ends.

The owner asked: "then its time to have image generation feature on conclave. research and think of where and how it can be exist in our conclave".

Today Conclave cannot make a raster image. RenderFile turns HTML, SVG or Markdown into a PNG or PDF with Chromium. It does not generate pictures. CHAT-AND-MOTION.md section 2.10 lists image generation as out for now. This doc says where it goes, how it reaches a model, and what phase 1 builds.

Decisions this doc makes (the owner can change them in section 9):

| Question | Decision |
|---|---|
| Where it lives | One tool, `GenerateImage`, that agents call. Results show as image cards in the reply. |
| First provider | CLIProxyAPI (`cliproxy`), `POST /v1/images/generations`, OpenAI image models from the owner's ChatGPT Plus account. |
| Default model | `gpt-image-2.5`, quality `medium`, size `1024x1024`. |
| Where files go | The session's outputs folder, the same place as RenderFile and ShareFile. |
| Cost | A usage row per call with `purpose: 'image'`. Subscription calls cost 0 and keep an API value. |
| Phase 1 surfaces | The tool on `chat` and `assistant`, inline image cards with a full-screen viewer on web. Nothing else. |

What phase 1 does not build: an Images page, a composer toggle or `/image` command, mask painting, Gemini images, local ComfyUI, partial-image streaming.

## 1. What the evidence says

Claims from the research round, with sources. Treat them as claims until a call proves them.

### 1.1 How other products do it

| Product | Pattern | Editing |
|---|---|---|
| OpenAI API | The chat model calls an image tool and chooses new image or edit ([guide](https://developers.openai.com/api/docs/guides/image-generation)) | Prompt based. The edit endpoint also takes a mask. |
| Gemini app | Plain words ("draw", "create") ([help](https://support.google.com/gemini/answer/14286560)) | Upload an image and ask. Several reference images. |
| Grok API | Tool call. The model writes the prompt and picks the aspect ratio ([docs](https://docs.x.ai/developers/tools/image-generation)) | Any image already in the conversation. |
| Open WebUI | Both: an "Image" switch in the composer, and a native tool call ([docs](https://docs.openwebui.com/features/chat-conversations/image-generation-and-editing/usage/)) | Image plus prompt in chat. No mask UI. |
| LibreChat | Agent tools per engine (OpenAI, Gemini, Flux, SD) ([docs](https://www.librechat.ai/docs/features/image_gen)) | Upload, then prompt. |
| claude.ai | No native image generation ([help](https://support.claude.com/en/articles/9002504-can-claude-produce-images)) | None. |

The common pattern: one tool the chat model calls, results inline in the chat, editing by sending an image back with words. Mask editors are rare in chat products. No source showed a per-image cost to the user.

### 1.2 API shapes

| API | Request | Response | Limits |
|---|---|---|---|
| OpenAI generations ([ref](https://developers.openai.com/api/reference/resources/images/methods/generate)) | JSON: `model`, `prompt`, `n` 1 to 10, `size` (`WxH`, both divisible by 16, ratio 1:3 to 3:1, max 3840x2160), `quality` low, medium, high, auto (2.5 adds xhigh, max), `output_format` png, jpeg, webp, `background` transparent, opaque, auto, `partial_images` 0 to 3 | `data[].b64_json` only. `response_format` is not supported for gpt-image models. | `gpt-image-1` shut down 2026-10-23. |
| OpenAI edits ([ref](https://developers.openai.com/api/reference/resources/images/methods/edit)) | Multipart: up to 16 `image[]`, optional `mask` (applies to the first image), `markup` overlay (2.5 only, not with `mask`) | Same as generations. Stream events `image_edit.partial_image`, `image_edit.completed`. | Default edit model is `gpt-image-2.5-sunburst`. |
| Gemini via chat completions on CLIProxyAPI ([discussion](https://github.com/router-for-me/CLIProxyAPI/discussions/378)) | `POST /v1/chat/completions` with `modalities: ["image","text"]` | `choices[0].message.images[].image_url.url` as a data URL | Up to 14 reference images upstream. |
| Cloudflare Workers AI ([model](https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/)) | `POST /ai/run/@cf/black-forest-labs/flux-1-schnell` | Base64 image | 10,000 free neurons a day, about 65 Flux schnell images by the researcher's math. |
| ComfyUI ([routes](https://docs.comfy.org/development/comfyui-server/comms_routes)) | `POST /prompt` with a workflow graph, then `GET /history/{id}`, `GET /view` | PNG bytes, progress on `/ws` | Flux.2 Klein 4B fp8 needs about 8.4 GB VRAM, so it fits the RTX 5070's 12 GB. Needs PyTorch cu130 or newer. |

OpenAI variants: `-sunburst` for edit precision, `-flare` for speed (OpenAI guide). Price: image output tokens at $30 per 1M for gpt-image-2.5 and gpt-image-2, no per-image table ([pricing](https://developers.openai.com/api/docs/pricing)). Gemini 3.1 Flash Image is $0.067 per 1K image ([pricing](https://aistudio.google.com/docs/pricing.md)).

### 1.3 CLIProxyAPI

| Fact | Source |
|---|---|
| `/v1/images/generations` gave 404 on v6.9.30. Handlers exist from v6.9.34. 200 with `b64_json` by v6.9.38. | [issue 2940](https://github.com/router-for-me/CLIProxyAPI/issues/2940), [vibeproxy 343](https://github.com/automazeio/vibeproxy/issues/343) |
| Config has a per-model `image: false` flag. Set it true to allow a model on `/v1/images/*`. | [config.example.yaml](https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml) |
| A global switch disables images everywhere, and then the route returns 404. | [docs](https://help.router-for.me/configuration/basic) |
| v7.0.0: a `gpt-image-2` request was resolved as `gpt-5.4-mini` and gave 502. | [issue 3314](https://github.com/router-for-me/CLIProxyAPI/issues/3314) |
| Image models work only on `/v1/images/generations` and `/v1/images/edits`. | [issue 6196](https://github.com/router-for-me/CLIProxyAPI/issues/6196) |
| v8.0.45 and v8.0.48 carry image fixes (multipart params, usage capture). Latest is v8.0.53. One tracker says OpenAI images work on v8.0.48. | [releases](https://github.com/router-for-me/CLIProxyAPI/releases) |
| Gemini native image ids may be rejected on `/v1/images/generations`. Unconfirmed upstream. | [fork PR 7](https://github.com/zyaireleo/CLIProxyAPI/pull/7) |

### 1.4 Live probe (2026-11-03)

The probe made no image. No API key was reachable from the session.

| Check | Result |
|---|---|
| Which CLIProxyAPI the hub uses | `providers.cliproxy` is `type: openai`, `baseUrl: http://127.0.0.1:37383/v1`: a hub-managed local `cli-proxy-api` on the conclave CT, not Madx at 192.168.0.60:8317. Its model list includes `gpt-image-2.5`. |
| `GET /v1/models` without a key, local and Madx | 401 "Missing API key" |
| `POST /v1/images/generations` and `/v1/images/edits` without a key | 401. A missing route (`/v1/does-not-exist`) gives 404, so both image routes exist on the local proxy. |
| A real generation | Not done. Whether this proxy returns an image is untested. |

Before phase 1 code, the owner runs one call with the key (the key goes where `xxxxxxxxxxx` is):

```bash
curl -sS -w '\n%{http_code} %{time_total}\n' \
  -H 'Authorization: Bearer xxxxxxxxxxx' -H 'Content-Type: application/json' \
  -d '{"model":"gpt-image-2.5","prompt":"a small red cube on a white table, studio light","size":"1024x1024","n":1}' \
  http://127.0.0.1:37383/v1/images/generations | head -c 400
```

| Outcome | Next step |
|---|---|
| 200 with `data[0].b64_json` | Build phase 1 as written. Note the `usage` fields and the time. |
| 404 | Images are off in the proxy config. Turn the global switch on and set `image: true` on the image models. |
| 502 or a chat model answers | The v7 routing bug. Update the hub's CLIProxyAPI to v8.0.48 or newer (v8.0.53 now), then repeat. |
| 401 or 403 from upstream | The ChatGPT Plus sign-in lacks image access. Sign in again in Settings > Accounts. |

Updating is an owner action. Madx (CT 127) runs v8.0.20 and should move to v8.0.48 or newer too, so both proxies behave the same.

## 2. Where it lives

Each surface, decided:

| Surface | Decision | Phase |
|---|---|---|
| `GenerateImage` tool | Yes. The one entry point. Agents call it when the owner asks for a picture. | 1 |
| `EditImage` tool | No separate tool. `GenerateImage` takes `images` (references or the image to edit) and an optional `mask`. One tool is easier for the model to choose. | 1 (references), 2 (mask) |
| Inline image cards in the reply | Yes. Reuse ShareFile cards, which already show PNG, JPEG, GIF and WebP up to 20 MB inline (`files/words.ts` `IMAGE_PREVIEW_MAX`). Several images from one call sit in a grid. | 1 |
| Full-screen viewer | Yes: on web `ImageThumb`'s dialog (`components/ui/ImageViewer.tsx`) in `ImageGrid`; on Android the chat's `FullImage` (pinch to zoom) from `FileCardsView`'s grid. | 1 |
| Composer "Image" toggle or `/image` | Not in phase 1. The model already sees the ask in plain words. Add only if the model misses image asks in practice. | 3, if needed |
| Images page (gallery) | Phase 2. A list of the account's generated images across sessions, with "Use as reference" and Download. | 2 |
| Image model setting | Phase 1, in Settings > Models: "Image model", a picker that shows only image models (the inverse of `NON_CHAT`). | 1 |
| web-studio and the inspiration board | Phase 2. web-studio gets a step to make hero or texture assets. SaveInspiration can store a generated image. | 2 |
| RenderFile | Stays as it is. It is for layouts, charts and documents. The prompt note says: "RenderFile for layouts and charts, GenerateImage for pictures". | 1 (prompt note) |
| Workflows (`lib`) | Phase 2. A workflow step calls the same core function the tool calls. | 2 |
| Meetings | No. A live overlay has no use for slow images. | Never |

### 2.1 Which agents get the tool

| Agent | Tool | Why |
|---|---|---|
| `chat` | In `tools:` | The Chat page is where the owner asks for pictures. |
| `assistant` | In `optInTools` | Next to RenderFile and SaveInspiration. |
| `coder` | Off by default. An agent can add it to `optInTools`. | Coding sessions rarely need pictures. Members of web-studio can opt in. |
| Members' agents | Allowed, billed to the member's own account (4.3) | Opt-in tools are hub-only for members today (`engine.ts:2334`). The tool must not take the owner's image quota for a member. |

Any session needs ShareFile for a card. Without ShareFile the tool still saves the file and returns its path.

## 3. Providers

### 3.1 Interface

Add one optional method to `Provider` (`providers/types.ts`), the same way `embed?` was added:

```ts
generateImage?(req: ImageRequest): Promise<ImageResult>;

interface ImageRequest {
  model: string;
  prompt: string;
  n?: number;            // default 1
  size?: string;         // 'WxH' or 'auto'
  quality?: 'low' | 'medium' | 'high' | 'auto';
  format?: 'png' | 'jpeg' | 'webp';
  background?: 'transparent' | 'opaque' | 'auto';
  images?: { bytes: Uint8Array; mime: string }[];   // references or image to edit
  mask?: { bytes: Uint8Array; mime: string };
  signal?: AbortSignal;
}

interface ImageResult {
  images: { bytes: Uint8Array; mime: string; revisedPrompt?: string }[];
  usage?: Usage;          // when the provider reports image tokens
}
```

The OpenAI provider (`providers/openai.ts`) implements it: no `images` means JSON to `{baseUrl}/images/generations`; `images` means multipart to `{baseUrl}/images/edits`. It reuses `this.headers()` and `this.http()`, as `embed` does. `cliproxy` is an OpenAI-type provider, so it gets this with no extra code.

Later engines plug into the same method:

| Engine | How | Phase |
|---|---|---|
| OpenAI API key | Same OpenAI provider, official base URL | 1 for free (same code) |
| Gemini through cliproxy | `/v1/chat/completions` with `modalities`, read `message.images` | 2 |
| Gemini key | Gemini provider, `generateContent` with `responseModalities: ['TEXT','IMAGE']`, read `inlineData` | 2 |
| Cloudflare Workers AI | A small `cloudflare-images` provider type with an account id and token | 3 |
| ComfyUI on MadX Arch (RTX 5070) | A `comfyui` provider type that posts a stored Flux workflow and reads `/history` | 3 |

### 3.2 Models

ModelInfo gets `kind?: 'chat' | 'image' | 'embedding'`. The cliproxy model list sets `kind: 'image'` for ids that match the current `NON_CHAT` image part. The web and Android pickers then filter on `kind` and the regex stays only as the fallback.

| Model on cliproxy | Use |
|---|---|
| `gpt-image-2.5` | Default. |
| `gpt-image-2.5-flare` | "Fast" in the tool. |
| `gpt-image-2.5-sunburst` | Default when the call has an image to edit. |
| `gpt-image-2`, `gpt-image-1.5` | Fallback when 2.5 fails, picked by the owner in settings. |
| `gemini-3.1-flash-image` | Phase 2, through the chat route (1.3). |

How a model is picked, first match wins: the tool's `model` input (only an image model the account can reach), the account's "Image model" setting, then `cliproxy/gpt-image-2.5`. With no image model reachable, the tool is left out of the turn's tool list and the prompt note says so.

### 3.3 Tiers

The tool exposes plain tiers. The model does not pick pixels unless asked.

| Tool input | Maps to |
|---|---|
| `quality: 'draft'` | `quality: low`, `-flare` model |
| `quality: 'normal'` (default) | `quality: medium` |
| `quality: 'best'` | `quality: high` |
| `aspect: 'square'` (default), `'portrait'`, `'landscape'`, `'wide'` | 1024x1024, 1024x1536, 1536x1024, 1792x1024 (wide is 16 aligned: 1792 and 1024) |
| `size: 'WxH'` | Passed through after the checks in 1.2 |

`xhigh` and `max` are not exposed in phase 1.

## 4. Editing

| Ask | What the tool does | API |
|---|---|---|
| "Make the sky purple" on an attached image | `images: [attachment]`, prompt as given | OpenAI edits |
| "Make it darker" on an image it just made | `images: ['<outputs path of the last image>']` | OpenAI edits |
| "Put this logo on a mug" | Several references, up to 16 | OpenAI edits |
| "Change only this area" | `mask`: PNG with alpha, transparent where to change, same size as the first image | OpenAI edits, phase 2 UI |
| "Give me 3 versions" | `n: 3` on the same prompt and references. There is no separate variations call for gpt-image models. | generations or edits |

Inputs the tool accepts in `images`: a path in the session's outputs folder, or an attachment id of the current chat. The tool reads the bytes itself; it never takes a URL, so it cannot fetch from the network.

Phase 2 adds a mask painter in the web full-screen viewer: a brush over the image that exports a mask PNG and sends it with the next message. Until then the model edits from words, as most chat products do.

## 5. Storage, cost and accounts

### 5.1 Files

| Item | Rule |
|---|---|
| Folder | `outputsDir(home, sessionId)` (`files/share.ts`), the same folder RenderFile writes to. It is already per session, and sessions are per account. |
| Name | `image-<yyyymmdd-hhmmss>-<n>.<ext>`, or a short name the model gives (`hero.png`). Never overwrite: add `-2`, `-3`. |
| Format | PNG by default. JPEG or WebP when asked. Bytes are written as the provider returns them, with no re-encode. |
| Size | Refuse a result over 30 MB (the ShareFile limit). At 3840x2160 PNG this is near the limit. |
| Sidecar | `<name>.json` next to the image: prompt, revised prompt, model, size, quality, source images, usage id. The gallery (phase 2) reads these. |
| Thumbnails | None in phase 1. Cards show the file itself under 20 MB. Phase 2 gallery: a 384 px WebP made once by the hub with the Chromium that RenderFile already uses, so no new dependency. |
| Cards | The tool's result carries `meta.files` (path, device, name, mediaType, size, like ShareFile's `meta.file`), so the clients draw the grid as soon as the call ends; `GET /api/sessions/:id/files/:toolUseId?image=N` serves picture N of the call. The runner's turn-end pass (`session/runner.ts:1866`) still adds a ShareFile card for each file; the clients hide those behind the grid by file name. |

### 5.2 Usage and price

Each call records one usage row (`UsageService.record`):

| Field | Value |
|---|---|
| `source` | `'tool'` |
| `provider`, `model` | e.g. `cliproxy`, `gpt-image-2.5` |
| `purpose` | `'image'` |
| tokens | From the response's `usage` when present, else 0 |
| `costUsd` | 0 on a subscription provider. On an API key, from tokens at the catalog price, or a per-image table when tokens are missing. |
| `apiValueUsd` | Per-image list price, so Usage shows what the subscription saved. |
| `account` | The session's account (the service falls back session, device, owner). |

`build()` already takes an explicit `costUsd` and `apiValueUsd`, so no schema change. The catalog import (`catalog.ts:264`) drops every LiteLLM mode except chat and responses. Phase 1 keeps a small hand table of per-image prices by model, quality and size in `catalog.ts`, with the date it was checked.

### 5.3 Members

A member's call uses the member's own providers and sign-ins, never the owner's. When the member has no image model, the tool is left out of the member's turn. The member gate in `engine.ts:2334` lists the tool as hub-only until this rule is in place.

### 5.4 Quotas and approval

| Rule | Value |
|---|---|
| Per call | `n` at most 4 in phase 1. |
| Per account per day | 50 images, a setting. Over it the tool says "Daily image limit reached (50). Change it in Settings > Models." |
| Approval | `readOnly: false`, so it asks outside bypass mode and allow rules, as Write does. No extra card: the owner dislikes approval cards. |
| Expensive calls | On an API-key provider, `quality: 'best'` or `n > 1` asks even in bypass mode, with the estimated price in the reason. On a subscription provider they do not ask. |

### 5.5 Safety

A provider refusal goes back to the model as the tool's error, word for word ("The image provider refused: <message>"), and the model tells the owner plainly. The tool never rewrites a prompt to get past a refusal, and the prompt note says not to try. Generated files keep whatever provenance data (C2PA) the provider embeds; Conclave does not strip it.

## 6. API and data model

### 6.1 Tool schema

```json
{
  "name": "GenerateImage",
  "input_schema": {
    "type": "object",
    "required": ["prompt"],
    "properties": {
      "prompt":  { "type": "string", "maxLength": 4000 },
      "images":  { "type": "array", "maxItems": 16, "items": { "type": "string" },
                   "description": "Outputs paths or attachment ids to edit or use as references" },
      "mask":    { "type": "string", "description": "Outputs path of a PNG mask (phase 2)" },
      "n":       { "type": "integer", "minimum": 1, "maximum": 4 },
      "aspect":  { "enum": ["square", "portrait", "landscape", "wide"] },
      "size":    { "type": "string", "pattern": "^(auto|\\d{2,4}x\\d{2,4})$" },
      "quality": { "enum": ["draft", "normal", "best"] },
      "format":  { "enum": ["png", "jpeg", "webp"] },
      "background": { "enum": ["auto", "transparent", "opaque"] },
      "name":    { "type": "string", "description": "File name without folder" },
      "model":   { "type": "string" }
    }
  }
}
```

Tool fields: `readOnly: false`, `optIn: true`, `timeoutMs: 180_000`. It is appended at the end of `BUILTINS` in `tools/index.ts`, because the list order is cache stable. It is added to `CHAT_FILE_TOOLS` in `session/runner.ts:81` so relative paths resolve in outputs.

Result text: `Saved 2 images: image-20261103-101500-1.png, image-20261103-101500-2.png (gpt-image-2.5, 1024x1024, medium, 31 s).` plus the revised prompt when the provider gave one.

### 6.2 Routes

Phase 1 adds no route. Files are served by the existing file routes for outputs.

Phase 2, for the gallery:

| Route | Does |
|---|---|
| `GET /api/images?cursor=` | The account's images, newest first, from the sidecars: path, session, prompt, model, size, time. |
| `POST /api/images/:id/reference` | Attach the image to a new or current chat message as a reference. |
| `DELETE /api/images/:id` | Remove the file and its sidecar. |

### 6.3 Progress events

Phase 1: the tool row shows "Making an image" with the elapsed time, using the existing tool progress text. Typical calls take 15 to 60 s.

Phase 2: with `partial_images: 2`, the tool sends `tool_progress` events with `{ kind: 'image_partial', index, b64 }` (small, about 256 px). The web draws the latest partial blurred in the card until the final file lands. Android ignores the event and waits for the card.

## 7. Phases

| Phase | Builds | Done when |
|---|---|---|
| 0 | The owner's curl (1.4), proxy update if needed | One 200 with an image from the hub's cliproxy |
| 1 | `generateImage` on the OpenAI provider, `GenerateImage` tool (generate and references), `kind` on ModelInfo, Image model setting, outputs files and sidecars, usage rows, per-image price table, full-screen viewer in web `FileCard`, `chat` and `assistant` agents, prompt note | The owner asks the Chat page for a picture and sees it inline, on web and Android, with a usage row |
| 2 | Mask painter, Gemini (cliproxy chat route and key), Images page, partial images, web-studio and inspiration hooks, workflow step | |
| 3 | Cloudflare and ComfyUI providers, composer toggle if needed | |

### 7.1 Tests

| Test | Checks |
|---|---|
| `core/test/providers/openai-images.test.ts` | Request body for generations and edits (multipart, mask), `b64_json` decode, error mapping (400 refusal, 404, 502) against a fake server |
| `core/test/tools/generate-image.test.ts` | Model pick order, tier mapping, size check, `n` cap, daily cap, file naming without overwrite, sidecar, usage row with `purpose: 'image'`, refusal text passed through, no URL inputs |
| `core/test/engine/member-image.test.ts` | A member's call uses the member's provider; no image model means no tool |
| `web/test/model-picker.test.tsx` | Chat picker hides `kind: 'image'`; Image model picker shows only them |
| `web/test/file-card.test.tsx` | Image card opens the full-screen viewer |
| Android `ModelPicksRoutesTest.kt` | Same filter on `kind` |

## 8. Risks

| Risk | Mitigation |
|---|---|
| The hub's CLIProxyAPI returns no image (old version, config off) | Phase 0 before code. Update to v8.0.48 or newer. |
| ChatGPT Plus image quota is unknown and may run out mid-day | Show the provider's 429 text. Fallback to the next model in settings only when the owner set one. |
| CLIProxyAPI image behavior changes between versions | The provider test pins the request and response shape. A version line in the tool's error helps triage. |
| Large PNGs (4K) near the 30 MB card limit and slow on phones | Default 1024. Sizes over 2048 need `quality: 'best'` asked for in words. |
| Model calls the tool when the owner wanted an SVG chart | Prompt note: GenerateImage for pictures and photos, RenderFile or SVG for charts, diagrams and text layouts. |
| Per-image prices drift | The hand table carries its check date; Usage shows API value, not a bill, on subscriptions. |

## 9. Questions for the owner

| # | Question | Recommended answer |
|---|---|---|
| 1 | Run the phase 0 curl on the hub's cliproxy, and update CLIProxyAPI (hub and Madx) to v8.0.53 if it fails? | Yes. Phase 1 waits on one working call. |
| 2 | Default model and quality? | `gpt-image-2.5` at `medium`, 1024x1024. |
| 3 | Ask before each image outside bypass mode? | Yes, as Write does. No extra card. In bypass, ask only for costly API-key calls. |
| 4 | Daily cap per account? | 50 images, changeable in Settings > Models. |
| 5 | Can members generate images? | Yes, only on their own sign-ins or keys. |
| 6 | Composer "Image" toggle in phase 1? | No. Add it only if the chat model misses image asks. |
