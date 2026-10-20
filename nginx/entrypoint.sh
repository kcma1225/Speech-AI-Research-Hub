#!/bin/sh
# Renders the nginx config from templates for HTTP-only or HTTP→HTTPS mode, then starts nginx.
set -eu
: "${APP_HOSTNAME:?APP_HOSTNAME required}"
: "${APP_ORIGIN:?APP_ORIGIN required}"
HTTPS_ENABLED="${HTTPS_ENABLED:-false}"
case "$APP_HOSTNAME" in *[!a-zA-Z0-9.:-]*) echo 'Invalid APP_HOSTNAME' >&2; exit 1;; esac
case "$APP_ORIGIN" in http://*|https://*) ;; *) echo 'Invalid APP_ORIGIN' >&2; exit 1;; esac

SCRIPT_HASHES="$(cat /etc/nginx/script-hashes)"
export APP_HOSTNAME SCRIPT_HASHES
out=/etc/nginx/conf.d
rm -f "$out"/*.conf "$out"/*.inc

case "$HTTPS_ENABLED" in
  true)
    for file in fullchain.pem privkey.pem; do
      [ -s "/etc/nginx/certs/$file" ] || { echo "Missing /etc/nginx/certs/$file" >&2; exit 1; }
    done
    case "$APP_ORIGIN" in https://*) ;; *) echo 'HTTPS_ENABLED=true requires an https:// APP_ORIGIN' >&2; exit 1;; esac
    HSTS_HEADER='add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;'
    ;;
  false)
    HSTS_HEADER=''
    ;;
  *) echo 'HTTPS_ENABLED must be true or false' >&2; exit 1;;
esac
export HSTS_HEADER

vars='${APP_HOSTNAME} ${SCRIPT_HASHES} ${HSTS_HEADER}'
envsubst "$vars" </etc/nginx/snippets/spa-headers.conf >"$out/spa-headers.inc"
envsubst "$vars" </etc/nginx/hub-templates/locations.conf.template >"$out/locations.inc"
if [ "$HTTPS_ENABLED" = true ]; then
  # Port 80 only redirects (plus the health probe); everything is served on 443.
  cat >"$out/http.conf" <<CONF
server {
    listen 80 default_server;
    server_name ${APP_HOSTNAME};
    location = /nginx-health { access_log off; default_type text/plain; return 200 "ok\n"; }
    location / { return 308 https://\$host\$request_uri; }
}
CONF
  envsubst "$vars" </etc/nginx/hub-templates/https.conf.template >"$out/https.conf"
else
  envsubst "$vars" </etc/nginx/hub-templates/http.conf.template >"$out/http.conf"
fi

# Optional Aldine LaTeX editor (compose profile `latex`) on its own hostname.
LATEX_HOSTNAME="${LATEX_HOSTNAME:-}"
if [ -n "$LATEX_HOSTNAME" ]; then
  case "$LATEX_HOSTNAME" in *[!a-zA-Z0-9.:-]*) echo 'Invalid LATEX_HOSTNAME' >&2; exit 1;; esac
  [ "$LATEX_HOSTNAME" != "$APP_HOSTNAME" ] || { echo 'LATEX_HOSTNAME must differ from APP_HOSTNAME' >&2; exit 1; }
  : "${LATEX_REGISTER_PASSWORD:?LATEX_REGISTER_PASSWORD required when LATEX_HOSTNAME is set}"
  printf 'owner:%s\n' "$(openssl passwd -apr1 "$LATEX_REGISTER_PASSWORD")" >"$out/latex-register.htpasswd"
  chmod 640 "$out/latex-register.htpasswd" && chgrp nginx "$out/latex-register.htpasswd"
  export LATEX_HOSTNAME
  latex_vars='${LATEX_HOSTNAME} ${HSTS_HEADER}'
  envsubst "$latex_vars" </etc/nginx/hub-templates/latex-locations.conf.template >"$out/latex-locations.inc"
  if [ "$HTTPS_ENABLED" = true ]; then
    envsubst "$latex_vars" </etc/nginx/hub-templates/latex-https.conf.template >"$out/latex.conf"
    # The port-80 server above redirects only APP_HOSTNAME; redirect the LaTeX host too.
    printf 'server { listen 80; server_name %s; location / { return 308 https://$host$request_uri; } }\n' "$LATEX_HOSTNAME" >>"$out/latex.conf"
  else
    envsubst "$latex_vars" </etc/nginx/hub-templates/latex.conf.template >"$out/latex.conf"
  fi
fi

nginx -t
exec nginx -g 'daemon off;'
