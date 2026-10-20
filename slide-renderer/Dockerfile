# Pinned: same Quarto as host render, reproducible builds. amd64-only upstream image; platform set in compose.yaml.
FROM ghcr.io/quarto-dev/quarto:1.10.19
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 fontconfig libnss3 libatk-bridge2.0-0 libgtk-3-0 libasound2 libx11-xcb1 libgbm1 libxss1 libxtst6 && rm -rf /var/lib/apt/lists/*
COPY build-assets.py /usr/local/bin/build-assets.py
RUN python3 /usr/local/bin/build-assets.py && chmod -R a+rX /opt/chrome /opt/slide-assets && chmod 0555 /opt/chrome/chrome-headless-shell
COPY render-worker.sh offline-pdf.sh prepare-pdf.py /usr/local/bin/
RUN chmod 0555 /usr/local/bin/render-worker.sh /usr/local/bin/offline-pdf.sh /usr/local/bin/prepare-pdf.py && ln -s /usr/local/bin/render-worker.sh /usr/local/bin/render-worker
# Root filesystem is read-only at runtime; Quarto/Deno caches go to tmpfs.
ENV HOME=/tmp XDG_CACHE_HOME=/tmp/.cache XDG_DATA_HOME=/tmp/.local/share XDG_CONFIG_HOME=/tmp/.config DENO_DIR=/tmp/.deno
USER 1001:1001
ENTRYPOINT ["/usr/local/bin/render-worker"]
