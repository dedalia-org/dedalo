# Dédalo v7 — SIMPLE nginx configuration WITH TLS (no media access control).
#
# TEMPLATE — not used directly. `install.sh` substitutes the three @@…@@ markers
# and writes deploy/nginx.simple.generated.conf, which docker-compose.simple.yml
# mounts. Edit this file to change every future generation; edit the generated
# one for a one-off (it is overwritten on the next install).
#
#   @@SERVER_NAME@@   the domain, or `_` for "any name" (local-CA / IP access)
#   @@SSL_CERT@@      full-chain certificate path, as seen INSIDE the container
#   @@SSL_KEY@@       private key path, as seen INSIDE the container
#
# Differs from deploy/nginx.conf (the full stack) in exactly one way: media is
# served OPENLY by the block below instead of through the engine-generated access
# rules. No per-record and no per-project checks — anyone who can reach this
# server reads every media file. TLS protects it in transit; it does not gate it.
#
# THE ROOT RULE: the media location carries no root/alias of its own, so the
# server `root` MUST satisfy
#     <root> + /dedalo/<DEDALO_MEDIA_DIR>/…  ==  MEDIA_PATH/…
# With MEDIA_PATH=/srv/dedalo/media and media dir 'media', that is `root /srv;`.

# ---------------------------------------------------------------------------
# REQUEST-RATE CEILING ON THE API DOOR (audit 2026-08-26 SEC-21).
#
# The engine's own login throttle is keyed by username and by (username, IP), so
# a caller that ROTATES the username minted a fresh bucket on every request, and
# nothing here bounded the RATE at all: with `client_max_body_size 300m` below,
# ONE unauthenticated client could keep the engine writing megabytes of audit
# rows for as long as it liked (measured 67 MB stored from a single request).
# The engine now bounds the payload and adds a source-global login bucket; this
# is the hop in front of it, and it is the one that costs the engine nothing.
#
# 20 r/s sustained with a burst of 40, per SOURCE ADDRESS, released as fast as
# nginx can (`nodelay`) so a legitimate page — which fans out into a dozen
# parallel component reads — is never delayed, only a flood is refused. 10 MB of
# shared state holds ~160k addresses.
#
# It sits in the `http` context, beside `upstream`, because that is the only
# context `limit_req_zone` is valid in; the `limit_req` that USES it is on the
# API location.
# ---------------------------------------------------------------------------
limit_req_zone $binary_remote_addr zone=dedalo_api:10m rate=20r/s;

upstream dedalo_ts {
	server unix:/run/dedalo/dedalo_ts.sock;
}

# --- Port 80: ACME challenges, and a redirect for everything else ------------
# The challenge location must stay on plain HTTP and must NOT redirect: that is
# how Let's Encrypt proves you still control the domain at every renewal. It is
# harmless in the other TLS modes — the directory is simply always empty.
server {
	listen 80;
	listen [::]:80;
	server_name @@SERVER_NAME@@;

	location /.well-known/acme-challenge/ {
		root /var/www/certbot;
	}

	location / {
		return 301 https://$host$request_uri;
	}
}

server {
	listen 443 ssl;
	listen [::]:443 ssl;
	http2 on;                       # multiplexes the 35-module client boot graph
	server_name @@SERVER_NAME@@;

	ssl_certificate     @@SSL_CERT@@;
	ssl_certificate_key @@SSL_KEY@@;
	ssl_protocols       TLSv1.2 TLSv1.3;
	ssl_prefer_server_ciphers off;
	ssl_session_cache   shared:SSL:10m;
	ssl_session_timeout 1d;

	# See THE ROOT RULE above.
	root /srv;

	# The client uploads in ~4 MB chunks and the engine accepts up to
	# SERVER_MAX_BODY_BYTES (256 MiB) per request. nginx's default is 1m, which
	# breaks every upload with a 413.
	client_max_body_size 300m;

	add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
	add_header X-Content-Type-Options    "nosniff"    always;
	add_header X-Frame-Options           "SAMEORIGIN" always;
	add_header Referrer-Policy           "strict-origin-when-cross-origin" always;

	# --- Media: SERVED OPENLY ------------------------------------------------
	# deploy/nginx.conf `include`s two engine-generated rule files here instead.
	# This block is their replacement, and it enforces nothing.
	location /dedalo/media/ {
		# No `alias`: the root rule above already resolves this to MEDIA_PATH.
		# A stat() cache would delay a deletion taking effect. Keep it off.
		open_file_cache off;
	}

	# --- Liveness probe → the Bun socket -------------------------------------
	location = /health {
		proxy_pass http://dedalo_ts;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}

	# --- API + dynamic routes → the Bun socket -------------------------------
	# A regex location beats every prefix location, so this keeps precedence over
	# the /dedalo/ static alias.
	location ~ ^/(api/v1/|dedalo/core/api/) {
		# The rate ceiling declared at the top of this file. `nodelay` releases
		# the burst immediately: a page load is a burst by nature.
		limit_req zone=dedalo_api burst=40 nodelay;
		proxy_pass http://dedalo_ts;
		proxy_http_version 1.1;
		proxy_set_header Host              $host;
		proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;
		# >= SERVER_IDLE_TIMEOUT_S (255). A lower value kills slow exports,
		# long searches and tool actions one hop before the engine would.
		proxy_read_timeout 300s;
		proxy_send_timeout 300s;
		# SSE + NDJSON streaming (assistant chat, diffusion, export).
		proxy_buffering off;
	}

	# --- Dynamic routes that live UNDER /dedalo/ but are NOT static files ----
	location /dedalo/lib/ {
		proxy_pass http://dedalo_ts;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}
	location /dedalo/tools/ {
		proxy_pass http://dedalo_ts;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}
	location /dedalo/core/tools_common/ {
		proxy_pass http://dedalo_ts;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}
	location = /dedalo/core/component_text_area/tag/ {
		proxy_pass http://dedalo_ts;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}
	location /dedalo/install/import/ontology/ {
		proxy_pass http://dedalo_ts;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}

	# Code-master release archives — only if this instance is a code master
	# (IS_A_CODE_SERVER=true). This is the URL the update manifest ADVERTISES to
	# remote installs; unrouted, every code update dies on a 404 from the client
	# alias below. Harmless otherwise: the engine 404s.
	location /dedalo/install/code/ {
		proxy_pass http://dedalo_ts;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}

	# Hierarchy export downloads (admin-session-gated).
	location /dedalo/install/import/hierarchy/ {
		proxy_pass http://dedalo_ts;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}

	# The local AI model store — ONNX weights the BROWSER fetches from the page
	# origin (transformers.js `env.remoteHost`). Served from the private dir, so
	# no client subtree answers it.
	location /dedalo/ai_models/ {
		proxy_pass http://dedalo_ts;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}

	# Staged-upload previews (the browser shows the file it just uploaded, before
	# the record is saved). Session-gated and owner-scoped by the engine.
	location /dedalo/upload_tmp/ {
		proxy_pass http://dedalo_ts;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}

	# tool_export's built files (csv/xlsx/ods/html/ndjson/media zip) — owner-only,
	# session-gated by the engine, 404 for anyone else. Multi-GB files: stream them
	# (no buffering to proxy temp files, which caps at proxy_max_temp_file_size).
	location /dedalo/export/artifact/ {
		proxy_pass http://dedalo_ts;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
		proxy_buffering off;
	}

	# --- Entry points --------------------------------------------------------
	location = /dedalo      { return 302 /dedalo/core/page/; }
	location = /dedalo/     { return 302 /dedalo/core/page/; }
	location = /dedalo/core { return 302 /dedalo/core/page/; }
	location = /dedalo/core/ { return 302 /dedalo/core/page/; }

	# --- Client static files -------------------------------------------------
	# The client tree is served IN PLACE (not content-hashed), so text assets
	# must revalidate — never mark them immutable.
	location /dedalo/ {
		alias /opt/dedalo/master_dedalo/client/dedalo/;
		etag on;
		add_header Cache-Control "no-cache";
		gzip on;
		gzip_types text/css application/javascript application/json image/svg+xml;
		gzip_min_length 1024;

		location ~* \.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$ {
			add_header Cache-Control "public, max-age=3600";
		}
	}

	location = / { return 302 /dedalo/core/page/; }
	location   / { return 404; }
}
