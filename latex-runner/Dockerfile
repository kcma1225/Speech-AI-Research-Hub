# syntax=docker/dockerfile:1
# latex-runner: claims `latex_compile` jobs and runs latexmk inside a per-compile bubblewrap sandbox.
# TeX Live comes from the Island of TeX "medium" image (pinned by digest) plus the collections typical
# Chinese/English theses and conference papers need; only /usr/local/texlive is copied into a slim
# Debian + Node base, which drops the base image's Java/GTK/Mesa (~700 MB) we never use.

# --- TeX Live tree -------------------------------------------------------------------------------
FROM texlive/texlive:latest-medium@sha256:c451d81d69a35763154d7e67d86c73bb047ef383be71a14b2fa37857cd9ec09f AS texlive
# Dated tlnet snapshot (the day after the base image was built) so rebuilds install the same revisions.
ARG TLNET=https://texlive.info/tlnet-archive/2026/10/19/tlnet
RUN tlmgr option repository "$TLNET" \
 && tlmgr install \
      collection-latexextra collection-pictures collection-bibtexextra collection-publishers collection-langcjk \
      fandol zhlipsum zhnumber hyphen-chinese luatexja \
      libertine newtx inconsolata txfonts fontawesome5 \
 && (tlmgr remove collection-context collection-texworks || echo "optional removal skipped")
# collection-latexextra pulls in collection-fontsextra (~1.7 GB of display fonts). Remove its members
# (and ConTeXt, TeXworks, the Java tlcockpit GUI) except the fonts common paper classes use
# (acmart: libertine/newtx/inconsolata; IEEE/Elsevier: newtx/txfonts; plus TeX Gyre/STIX2/Libertinus).
ARG KEEP_FONTS="libertine newtx inconsolata txfonts fontawesome5 fontaxes mweights kastrup xcharter libertinus-fonts libertinus-otf libertinus-type1 tex-gyre tex-gyre-math stix2-otf stix2-type1 newcomputermodern sourcecodepro sourcesanspro sourceserifpro sourcesans sourceserif"
RUN deps() { tlmgr info --data depends "$1" | tr ':,' '\n\n'; } \
 && { deps collection-fontsextra; deps collection-context; deps collection-texworks; echo tlcockpit; } \
      | grep -vxF -f "$(printf '%s\n' $KEEP_FONTS > /tmp/keep && echo /tmp/keep)" \
      | grep -v '^collection-' | sort -u > /tmp/drop \
 && tlmgr remove --force collection-fontsextra collection-context collection-texworks $(cat /tmp/drop) >/dev/null \
 && tlmgr list --only-installed | grep -c "^i" && du -sh /usr/local/texlive && rm /tmp/keep /tmp/drop
# Shell escape off for every engine (latexmk also passes -no-shell-escape); \openout stays paranoid.
RUN TL=$(ls -d /usr/local/texlive/20*) \
 && printf 'shell_escape = f\nopenout_any = p\nmax_print_line = 10000\nerror_line = 254\nhalf_error_line = 238\n' >> "$TL/texmf.cnf" \
 && ln -s "$(ls -d $TL/bin/*)" /usr/local/texlive/bin \
 && rm -rf "$TL/tlpkg/backups" "$TL/install-tl.log" "$TL/texmf-var/web2c/"*.log \
 && fmtutil-sys --all >/dev/null \
 && mktexlsr

# --- runner build --------------------------------------------------------------------------------
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# --- runtime -------------------------------------------------------------------------------------
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
RUN apt-get update && apt-get install -y --no-install-recommends perl fontconfig fonts-noto-cjk bubblewrap \
 && rm -rf /var/lib/apt/lists/*
COPY --from=texlive /usr/local/texlive /usr/local/texlive
ENV PATH=/usr/local/texlive/bin:$PATH
# luatexja (LuaLaTeX CJK, also used by ctex under LuaLaTeX) loads HaranoAji as its default fonts.
ARG TLNET=https://texlive.info/tlnet-archive/2026/10/19/tlnet
# tlmgr needs a downloader; curl is only present for this step.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && tlmgr option repository "$TLNET" && tlmgr install haranoaji \
 && kpsewhich HaranoAjiMincho-Regular.otf \
 && rm -rf /usr/local/texlive/20*/tlpkg/backups/* \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
# TeX Live's own OpenType/TrueType fonts become visible to fontconfig (XeTeX/fontspec look up by name).
RUN cp "$(ls -d /usr/local/texlive/20*)/texmf-var/fonts/conf/texlive-fontconfig.conf" /etc/fonts/conf.d/09-texlive.conf \
 && fc-cache -f >/dev/null \
 && fc-list | grep -q "Noto Serif CJK TC" \
 && mkdir -p /opt/par && PAR_GLOBAL_TEMP=/opt/par biber --version >/dev/null \
 && chmod -R a+rX /opt/par \
 && TEXMFVAR="$(ls -d /usr/local/texlive/20*)/texmf-var" luaotfload-tool --update >/dev/null \
 && mkdir /tmp/warm && cd /tmp/warm \
 && printf '%s\n' '\documentclass[fontset=none]{ctexart}' '\setCJKmainfont{Noto Serif CJK TC}' '\setCJKsansfont{Noto Sans CJK TC}' \
      '\begin{document}中文 English \textsf{黑體}\end{document}' > warm.tex \
 && TEXMFVAR="$(ls -d /usr/local/texlive/20*)/texmf-var" lualatex -interaction=nonstopmode warm.tex >/dev/null \
 && cd / && rm -rf /tmp/warm \
 && chmod -R a+rX /usr/local/texlive/20*/texmf-var \
 && mkdir -p /var/latex && chown 1001:1001 /var/latex && chmod 0700 /var/latex \
 && latexmk -v >/dev/null && xelatex -version >/dev/null && bwrap --version
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN chmod -R a+rX /app
# Root filesystem is read-only at runtime; project caches and per-compile scratch live on tmpfs/volume WORK_DIR.
ENV NODE_ENV=production HOME=/tmp WORK_DIR=/tmp/latex
USER 1001:1001
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD ["node", "/app/dist/healthcheck.js"]
STOPSIGNAL SIGTERM
CMD ["node", "/app/dist/main.js"]
