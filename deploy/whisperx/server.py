"""
Minimal HTTP wrapper around WhisperX (faster-whisper + wav2vec2 alignment + pyannote diarization).

Contract (consumed by backend/src/ai/asr/adapters/openai.ts, kind "whisperx"):

  GET  /health                     200 {"status":"ok"} | 503 {"status":"loading"}
  GET  /v1/models                  {"data":[{"id": <model>}]}
  GET  /v1/models/{id}             {"id": <model>} | 404
  POST /v1/audio/transcriptions    multipart/form-data, OpenAI-compatible plus extensions:
      file                 audio file (required)
      model                ignored unless it differs from the loaded model (then 404)
      language             ISO-639-1 ("zh", "en"); omitted = detect
      prompt               initial prompt (glossary / previous text)
      hotwords             comma-separated bias terms
      response_format      json | verbose_json (default) | text
      timestamp_granularities[]  accepted, words are always returned with verbose_json
      diarize              "true" | "false" (default false)
      min_speakers / max_speakers   ints, optional
    verbose_json response:
      {"text", "language", "duration",
       "segments": [{"id","start","end","text","speaker"?, "avg_logprob"?}],
       "words":    [{"word","start","end","score"?, "speaker"?}]}
    Errors: OpenAI shape {"error":{"message","type","code"}} with 400/401/404/413/500/503.

Auth: if API_KEY is set, requests need "Authorization: Bearer <API_KEY>" (health is public).
Env: WHISPERX_MODEL (large-v3), DEVICE (cuda), COMPUTE_TYPE (float16), BATCH_SIZE (16),
     HF_TOKEN (required for diarization; accept the pyannote model terms on Hugging Face),
     DIARIZATION_MODEL (pyannote/speaker-diarization-community-1), MAX_UPLOAD_MB (500).
"""

import dataclasses
import os
import tempfile
import threading

import uvicorn
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

MODEL_NAME = os.environ.get("WHISPERX_MODEL", "large-v3")
DEVICE = os.environ.get("DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("COMPUTE_TYPE", "float16" if DEVICE == "cuda" else "int8")
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "16"))
HF_TOKEN = os.environ.get("HF_TOKEN") or None
DIARIZATION_MODEL = os.environ.get("DIARIZATION_MODEL", "pyannote/speaker-diarization-community-1")
API_KEY = os.environ.get("API_KEY") or None
MAX_UPLOAD = int(os.environ.get("MAX_UPLOAD_MB", "500")) * 1024 * 1024

app = FastAPI(title="whisperx-wrapper")
state = {"model": None, "align": {}, "diarize": None, "error": None}
gpu_lock = threading.Lock()


def err(status: int, message: str, code: str = "error", type_: str = "invalid_request_error"):
    return JSONResponse(status_code=status, content={"error": {"message": message, "type": type_, "code": code}})


def load():
    try:
        import whisperx  # noqa: F401  (import here so /health answers while loading)

        state["model"] = whisperx.load_model(MODEL_NAME, DEVICE, compute_type=COMPUTE_TYPE)
    except Exception as e:  # pragma: no cover - surfaced through /health
        state["error"] = str(e)


threading.Thread(target=load, daemon=True).start()


@app.middleware("http")
async def auth(request: Request, call_next):
    if API_KEY and request.url.path != "/health":
        if request.headers.get("authorization") != f"Bearer {API_KEY}":
            return err(401, "invalid api key", "invalid_api_key")
    return await call_next(request)


@app.get("/health")
def health():
    if state["error"]:
        return JSONResponse(status_code=503, content={"status": "error", "detail": state["error"]})
    if state["model"] is None:
        return JSONResponse(status_code=503, content={"status": "loading"})
    return {"status": "ok"}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": MODEL_NAME, "object": "model"}]}


@app.get("/v1/models/{model_id:path}")
def model(model_id: str):
    if model_id != MODEL_NAME:
        return err(404, f"model {model_id} not found", "model_not_found")
    return {"id": MODEL_NAME, "object": "model"}


def set_options(model, **kw):
    """Per-request prompt/hotwords: WhisperX keeps faster-whisper options on the pipeline."""
    opts = model.options
    kw = {k: v for k, v in kw.items() if hasattr(opts, k)}
    if hasattr(opts, "_replace"):
        model.options = opts._replace(**kw)
    else:
        model.options = dataclasses.replace(opts, **kw)
    return opts


@app.post("/v1/audio/transcriptions")
def transcriptions(
    file: UploadFile = File(...),
    model: str = Form(None),
    language: str = Form(None),
    prompt: str = Form(None),
    hotwords: str = Form(None),
    response_format: str = Form("verbose_json"),
    diarize: str = Form("false"),
    min_speakers: int = Form(None),
    max_speakers: int = Form(None),
    temperature: float = Form(None),
):
    import whisperx

    if state["model"] is None:
        return err(503, "model is loading", "loading", "server_error")
    if model and model not in (MODEL_NAME, "whisper-1"):
        return err(404, f"model {model} not loaded (server runs {MODEL_NAME})", "model_not_found")
    with tempfile.NamedTemporaryFile(suffix=os.path.splitext(file.filename or "")[1] or ".bin") as tmp:
        size = 0
        while chunk := file.file.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD:
                return err(413, "file too large", "file_too_large")
            tmp.write(chunk)
        tmp.flush()
        try:
            audio = whisperx.load_audio(tmp.name)
        except Exception as e:
            return err(400, f"cannot decode audio: {e}", "unsupported_format")
    duration = len(audio) / 16000.0
    want_diarize = diarize.lower() in ("1", "true", "yes")
    if want_diarize and not HF_TOKEN:
        return err(400, "diarization needs HF_TOKEN on the server", "diarization_unavailable")

    with gpu_lock:
        m = state["model"]
        saved = set_options(m, initial_prompt=prompt or None, hotwords=hotwords or None)
        try:
            result = m.transcribe(audio, batch_size=BATCH_SIZE, language=language or None)
        finally:
            m.options = saved
        lang = result.get("language") or language or "en"
        try:
            if lang not in state["align"]:
                state["align"][lang] = whisperx.load_align_model(language_code=lang, device=DEVICE)
            model_a, meta = state["align"][lang]
            result = whisperx.align(result["segments"], model_a, meta, audio, DEVICE, return_char_alignments=False)
        except Exception:
            # No alignment model for this language: keep segment-level timestamps only.
            pass
        if want_diarize:
            if state["diarize"] is None:
                from whisperx.diarize import DiarizationPipeline

                try:
                    state["diarize"] = DiarizationPipeline(model_name=DIARIZATION_MODEL, use_auth_token=HF_TOKEN, device=DEVICE)
                except TypeError:
                    state["diarize"] = DiarizationPipeline(use_auth_token=HF_TOKEN, device=DEVICE)
            dz = state["diarize"](audio, min_speakers=min_speakers, max_speakers=max_speakers)
            result = whisperx.assign_word_speakers(dz, result)

    segments, words = [], []
    for i, s in enumerate(result.get("segments", [])):
        seg = {"id": i, "start": round(float(s.get("start", 0)), 3), "end": round(float(s.get("end", 0)), 3), "text": s.get("text", "").strip()}
        if s.get("speaker"):
            seg["speaker"] = s["speaker"]
        if "avg_logprob" in s:
            seg["avg_logprob"] = s["avg_logprob"]
        segments.append(seg)
        for w in s.get("words", []):
            if "start" not in w:
                continue  # numerals etc. without alignment
            word = {"word": w.get("word", ""), "start": round(float(w["start"]), 3), "end": round(float(w["end"]), 3)}
            if "score" in w:
                word["score"] = round(float(w["score"]), 3)
            if w.get("speaker"):
                word["speaker"] = w["speaker"]
            words.append(word)
    sep = "" if lang in ("zh", "ja", "th", "lo", "my", "yue") else " "
    text = sep.join(s["text"] for s in segments)
    if response_format == "text":
        return PlainTextResponse(text)
    if response_format == "json":
        return {"text": text}
    return {"task": "transcribe", "language": lang, "duration": round(duration, 3), "text": text, "segments": segments, "words": words}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
