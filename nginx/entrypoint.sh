#!/bin/sh
set -eu
: "${APP_HOSTNAME:?}"
: "${OVERLEAF_HOSTNAME:?}"
: "${APP_ORIGIN:?}"
case "$APP_HOSTNAME:$OVERLEAF_HOSTNAME" in *[!a-zA-Z0-9.:-]*) echo 'Invalid hostname' >&2; exit 1;; esac
case "$APP_ORIGIN" in http://*|https://*) ;; *) echo 'Invalid APP_ORIGIN' >&2; exit 1;; esac
case "$HTTPS_ENABLED" in
  true)
    for file in fullchain.pem privkey.pem; do
      [ -s "/etc/nginx/certs/$file" ] || { echo "Missing /etc/nginx/certs/$file" >&2; exit 1; }
    done
    case "$APP_ORIGIN" in https://*) ;; *) echo 'HTTPS requires HTTPS APP_ORIGIN' >&2; exit 1;; esac
    APP_HTTP_REDIRECT='return 308 https://$host$request_uri;'
    OVERLEAF_HTTP_REDIRECT='return 308 https://$host$request_uri;'
    export APP_HTTP_REDIRECT OVERLEAF_HTTP_REDIRECT
    envsubst '${APP_HOSTNAME} ${OVERLEAF_HOSTNAME} ${APP_ORIGIN} ${APP_HTTP_REDIRECT} ${OVERLEAF_HTTP_REDIRECT}' </etc/nginx/templates/default.conf.template >/etc/nginx/conf.d/default.conf
    envsubst '${APP_HOSTNAME} ${OVERLEAF_HOSTNAME} ${APP_ORIGIN}' </etc/nginx/templates/https.conf.template >/etc/nginx/conf.d/https.conf
    ;;
  false)
    APP_HTTP_REDIRECT=''
    OVERLEAF_HTTP_REDIRECT=''
    export APP_HTTP_REDIRECT OVERLEAF_HTTP_REDIRECT
    envsubst '${APP_HOSTNAME} ${OVERLEAF_HOSTNAME} ${APP_ORIGIN} ${APP_HTTP_REDIRECT} ${OVERLEAF_HTTP_REDIRECT}' </etc/nginx/templates/default.conf.template >/etc/nginx/conf.d/default.conf
    ;;
  *) echo 'HTTPS_ENABLED must be true or false' >&2; exit 1;;
esac
nginx -t
exec nginx -g 'daemon off;'
