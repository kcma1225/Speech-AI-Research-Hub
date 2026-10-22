#!/bin/sh
# Renders the nginx config from templates for HTTP-only or HTTP→HTTPS mode, then starts nginx.
set -eu
: "${APP_HOSTNAME:?APP_HOSTNAME required}"
: "${APP_ORIGIN:?APP_ORIGIN required}"
HTTPS_ENABLED="${HTTPS_ENABLED:-false}"
case "$APP_HOSTNAME" in *[!a-zA-Z0-9.:-]*) echo 'Invalid APP_HOSTNAME' >&2; exit 1;; esac
case "$APP_ORIGIN" in http://*|https://*) ;; *) echo 'Invalid APP_ORIGIN' >&2; exit 1;; esac

# Reverse proxy / CDN in front of nginx: trust its X-Forwarded-For so rate limits, logs and the backend
# see the real client IP. Space- or comma-separated IPs/CIDRs; empty = nginx is the edge.
TRUSTED_PROXIES="$(printf '%s' "${TRUSTED_PROXIES:-}" | tr ',' ' ')"

SCRIPT_HASHES="$(cat /etc/nginx/script-hashes)"
export APP_HOSTNAME SCRIPT_HASHES
out=/etc/nginx/conf.d
rm -f "$out"/*.conf "$out"/*.inc

if [ -n "$TRUSTED_PROXIES" ]; then
  {
    for proxy in $TRUSTED_PROXIES; do
      case "$proxy" in *[!0-9a-fA-F.:/]*) echo "Invalid TRUSTED_PROXIES entry: $proxy" >&2; exit 1;; esac
      printf 'set_real_ip_from %s;\n' "$proxy"
    done
    printf 'real_ip_header X-Forwarded-For;\nreal_ip_recursive on;\n'
  } >"$out/real-ip.conf"
fi

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

nginx -t
exec nginx -g 'daemon off;'
