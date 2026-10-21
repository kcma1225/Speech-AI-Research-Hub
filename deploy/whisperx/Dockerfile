# WhisperX HTTP wrapper (kind "whisperx" in the hub's ASR registry). Needs an NVIDIA GPU (~10 GB
# for large-v3 + pyannote) and the NVIDIA container toolkit. Not built by default; see
# compose.whisperx.yaml. WhisperX is BSD-2-Clause, faster-whisper MIT, pyannote.audio MIT
# (the pyannote model weights require accepting their terms on Hugging Face + HF_TOKEN).
FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Pinned; bump together and re-test (torch wheels from PyPI bundle CUDA 12 runtimes).
RUN pip install --no-cache-dir \
      "whisperx==3.4.2" \
      "fastapi==0.115.6" \
      "uvicorn==0.34.0" \
      "python-multipart==0.0.20"

RUN useradd --create-home --uid 10001 app
USER app
WORKDIR /home/app
COPY --chown=app server.py ./server.py

ENV HF_HOME=/home/app/.cache/huggingface \
    PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health').status==200 else 1)"
CMD ["python", "server.py"]
