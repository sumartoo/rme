# Disalin ke /etc/nginx/clinicrme-proxy.inc (dipakai nginx-clinicrme.conf)
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $clinicrme_conn;
proxy_read_timeout 120s;
client_max_body_size 25m;
add_header Strict-Transport-Security "max-age=31536000" always;
