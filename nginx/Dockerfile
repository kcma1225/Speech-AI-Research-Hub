FROM nginx:1.27-alpine
RUN rm /etc/nginx/conf.d/default.conf
COPY default.conf.template https.conf.template /etc/nginx/templates/
COPY entrypoint.sh /usr/local/bin/hub-nginx-entrypoint
ENTRYPOINT ["/bin/sh", "/usr/local/bin/hub-nginx-entrypoint"]
