# Aldine compiler plus Traditional Chinese fonts. The upstream image only ships Fandol (GB2312),
# which lacks common Traditional characters such as 週. Pinned to the same Aldine release as the app.
FROM ghcr.io/trahloff/aldine-compiler:0.12.3
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-cjk-extra \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f
